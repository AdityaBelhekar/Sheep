"""Sheep verification checker.

Runs inside the sandbox. Reads `input.json` — a list of requests — and prints
one JSON line per finding as it reaches it, so a checker that runs out of time
has still said everything it managed to decide.

Nothing here asks a language model anything. A step passes because SymPy
reduced a difference to zero, or fails because it did not, or is reported as
UNCHECKABLE because no rule here could decide it. That third answer is never
rounded up.

Statements arrive as text written by a model, so they are never evaluated as
Python. `read_expression` walks the syntax tree itself and builds SymPy objects
from a fixed vocabulary: numbers, names, arithmetic, and a list of functions.
There is no attribute access, no subscripting and no string to smuggle code in
— a statement cannot print a verdict of its own.
"""

import ast
import json
import sys

import sympy

PASS, FAIL, UNCHECKABLE = "PASS", "FAIL", "UNCHECKABLE"


class Unreadable(Exception):
    """A statement that is not in the language the checker reads."""


FUNCTIONS = {
    name: getattr(sympy, name)
    for name in (
        "sin cos tan asin acos atan sinh cosh tanh exp log sqrt Abs sign floor ceiling "
        "factorial binomial gamma erf Min Max re im conjugate Derivative Integral"
    ).split()
}

CONSTANTS = {"pi": sympy.pi, "E": sympy.E, "I": sympy.I, "oo": sympy.oo}

BINARY = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.Pow: lambda a, b: a**b,
}


def read_expression(source, symbols):
    try:
        tree = ast.parse(source.strip(), mode="eval")
    except SyntaxError as error:
        raise Unreadable(f"not an expression: {error.msg}") from None

    def build(node):
        if isinstance(node, ast.Constant):
            value = node.value
            if type(value) is int:
                return sympy.Integer(value)
            if type(value) is float:
                # 0.1 means one tenth, not the nearest binary fraction to it.
                return sympy.Rational(repr(value))
            raise Unreadable("only numbers may appear as literals")
        if isinstance(node, ast.Name):
            if node.id in symbols:
                return symbols[node.id]
            if node.id in CONSTANTS:
                return CONSTANTS[node.id]
            if node.id in FUNCTIONS:
                raise Unreadable(f"{node.id} is a function and needs arguments")
            return symbols.setdefault(node.id, sympy.Symbol(node.id))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            operand = build(node.operand)
            return -operand if isinstance(node.op, ast.USub) else operand
        if isinstance(node, ast.BinOp):
            if isinstance(node.op, ast.BitXor):
                raise Unreadable("write powers as **, not ^")
            operation = BINARY.get(type(node.op))
            if operation is None:
                raise Unreadable(f"the operator {type(node.op).__name__} is not allowed")
            left, right = build(node.left), build(node.right)
            if isinstance(node.op, ast.Pow) and right.is_Integer and abs(right) > 10_000:
                raise Unreadable("the exponent is too large to work with")
            return operation(left, right)
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
                raise Unreadable("only the known mathematical functions may be called")
            if node.keywords:
                raise Unreadable("functions take positional arguments only")
            return FUNCTIONS[node.func.id](*(build(argument) for argument in node.args))
        if isinstance(node, ast.Tuple):
            return sympy.Tuple(*(build(element) for element in node.elts))
        raise Unreadable(f"{type(node).__name__} is not allowed in an expression")

    try:
        return build(tree.body)
    except Unreadable:
        raise
    except Exception as error:  # e.g. a function called with the wrong arity
        raise Unreadable(f"{type(error).__name__}: {error}") from None


# The derivative of a bare symbol, and the opaque symbol that stands in for it.
_RATES = {}


def freeze(expression):
    """Replaces the derivative of a bare symbol with a symbol of its own.

    `Derivative(y, x)` in a statement means "the rate at which y changes",
    where y is whatever the derivation says it is. SymPy knows y only as a
    symbol, and the derivative of a symbol is zero — so the moment anything
    simplified it, dy/dx = 2x and dy/dx = -2x would both reduce to a claim
    about 2x and compare equal up to sign. Standing a symbol in for it keeps
    it the unknown it is.
    """

    def stand_in(derivative):
        symbol = sympy.Symbol(f"<{sympy.sstr(derivative)}>")
        _RATES[symbol] = derivative
        return symbol

    return expression.replace(
        lambda node: isinstance(node, sympy.Derivative) and node.expr.is_Symbol, stand_in
    )


def thaw(expression):
    return expression.xreplace(_RATES)


class Statement:
    """An expression, or an equation between two."""

    def __init__(self, sides):
        self.sides = tuple(freeze(side) for side in sides)

    @property
    def is_equation(self):
        return len(self.sides) == 2

    @property
    def difference(self):
        """What must be zero for the statement to hold."""
        return self.sides[0] - self.sides[1] if self.is_equation else self.sides[0]

    def map(self, function):
        return Statement(function(side) for side in self.sides)

    def render(self):
        try:
            sides = [thaw(side) for side in self.sides]
            shown = sympy.Eq(*sides, evaluate=False) if self.is_equation else sides[0]
            return sympy.latex(shown), sympy.mathml(shown, printer="presentation")
        except Exception:
            return None, None


def read_statement(source, symbols):
    if any(mark in source for mark in "<>!"):
        raise Unreadable("an inequality is a constraint, not a step in a derivation")
    sides = source.split("=")
    if len(sides) > 2:
        raise Unreadable("a statement is one expression, or two around a single =")
    return Statement(read_expression(side, symbols) for side in sides)


# ── Deciding ────────────────────────────────────────────────────────────────


def identical(left, right):
    """Whether two expressions are the same for every value of their symbols."""
    difference = left - right
    if difference == 0:
        return PASS, "both sides are the same expression", "structural"
    try:
        reduced = sympy.simplify(difference)
        if reduced == 0:
            return PASS, "the difference simplifies to zero", "symbolic"
        equal = reduced.equals(0)
    except Exception as error:
        return UNCHECKABLE, f"SymPy could not work on it: {type(error).__name__}: {error}", "none"
    if equal:
        return PASS, "the difference is zero", "symbolic"
    if equal is False:
        return FAIL, f"it differs from what the operation gives by {sympy.sstr(reduced)}", "symbolic"
    return (
        UNCHECKABLE,
        f"could not decide whether {sympy.sstr(reduced)} is zero",
        "none",
    )


def best(*verdicts):
    """PASS if any way of reading the step passes; FAIL only if every one fails."""
    for wanted in (PASS, UNCHECKABLE):
        for verdict in verdicts:
            if verdict[0] == wanted:
                return verdict
    return verdicts[0]


def matches(stated, expected):
    """Whether the statement a step makes is the one its operation produces."""
    if stated.is_equation != expected.is_equation:
        kinds = ("an equation", "an expression")
        got, wanted = kinds[not stated.is_equation], kinds[not expected.is_equation]
        return FAIL, f"the operation gives {wanted}, but the step states {got}", "structural"
    if not stated.is_equation:
        return identical(stated.sides[0], expected.sides[0])
    # An equation is the claim that a difference is zero, so it says the same
    # thing with its sides swapped or with a term moved across.
    return best(
        identical(stated.difference, expected.difference),
        identical(stated.difference, -expected.difference),
    )


class Step:
    """One step, with everything its operation may need."""

    def __init__(self, raw, stated, source, using, symbols):
        self.raw, self.stated, self.source, self.using, self.symbols = (
            raw,
            stated,
            source,
            using,
            symbols,
        )

    def argument(self, name):
        text = (self.raw.get("args") or {}).get(name)
        if text is None:
            raise Unreadable(f"this operation needs the argument `{name}`")
        return read_expression(text, self.symbols)

    def variable(self, name="var"):
        value = self.argument(name)
        if not value.is_Symbol:
            raise Unreadable(f"`{name}` has to be a single symbol")
        return value

    def equation(self, which="source"):
        statement = getattr(self, which)
        if statement is None:
            raise Unreadable("this operation needs a second statement, named by `using`")
        if not statement.is_equation:
            raise Unreadable("this operation works on an equation, not a bare expression")
        return statement


def rewrite(step):
    return matches(step.stated, step.source)


def both_sides(operation):
    def check(step):
        value = step.argument("value")
        return matches(step.stated, step.equation().map(lambda side: operation(side, value)))

    return check


def divide(step):
    value = step.argument("value")
    verdict = matches(step.stated, step.equation().map(lambda side: side / value))
    if verdict[0] != PASS:
        return verdict
    if sympy.simplify(value).is_zero:
        return FAIL, "it divides both sides by zero", "symbolic"
    if not value.is_nonzero:
        return (
            UNCHECKABLE,
            f"the algebra is right, but nothing shows {sympy.sstr(value)} is not zero; "
            "state the assumption if it holds",
            "symbolic",
        )
    return verdict


def apply_function(step):
    name = (step.raw.get("args") or {}).get("function", "").strip()
    if name not in FUNCTIONS:
        raise Unreadable("`function` has to name one of the known functions")
    return matches(step.stated, step.equation().map(FUNCTIONS[name]))


def substitute(step):
    using = step.equation("using")
    old, new = using.sides
    attempts = [
        matches(step.stated, step.source.map(lambda side: side.subs(old, new))),
        matches(step.stated, step.source.map(lambda side: side.subs(new, old))),
    ]
    # Textual replacement misses a quantity that appears in another form, so
    # also ask the real question: once the equation used has eliminated one of
    # its symbols, do the two statements say the same thing?
    for symbol in sorted(using.difference.free_symbols, key=str):
        if best(*attempts)[0] == PASS:
            break
        try:
            solutions = sympy.solve(using.difference, symbol)
        except Exception:
            continue
        if len(solutions) == 1:
            eliminate = lambda side: side.subs(symbol, solutions[0])  # noqa: E731
            attempts.append(matches(step.stated.map(eliminate), step.source.map(eliminate)))
    return best(*attempts)


def differentiate(step):
    variable = step.variable()

    def derive(side):
        # A lone symbol on one side of an equation is the quantity the other
        # side defines, so its derivative is written down rather than computed.
        # ponytail: a defined symbol buried inside an expression is still
        # treated as a constant — implicit differentiation is not modelled, and
        # a correct implicit derivative will be reported as not following.
        if step.source.is_equation and side.is_Symbol and side != variable:
            return sympy.Derivative(thaw(side), variable)
        return sympy.diff(side, variable)

    return matches(step.stated, step.source.map(derive))


def integrate(step):
    # Checked backwards: differentiating the result must give back the start.
    # That accepts any constant of integration, which is what an antiderivative is.
    variable = step.variable()
    return matches(step.stated.map(lambda side: sympy.diff(side, variable)), step.source)


def combine(sign):
    def check(step):
        first, second = step.equation(), step.equation("using")
        expected = Statement(a + sign * b for a, b in zip(first.sides, second.sides))
        return matches(step.stated, expected)

    return check


def solve(step):
    variable = step.variable("for")
    stated = step.equation("stated")
    if stated.sides[0] != variable:
        raise Unreadable(f"a solution has to be written as {variable} = ...")
    solutions = sympy.solve(step.equation().difference, variable)
    if not solutions:
        return UNCHECKABLE, f"SymPy found no closed-form solution for {variable}", "none"
    verdicts = [identical(stated.sides[1], solution) for solution in solutions]
    if not any(verdict[0] == PASS for verdict in verdicts):
        if all(verdict[0] == FAIL for verdict in verdicts):
            shown = ", ".join(sympy.sstr(solution) for solution in solutions)
            return FAIL, f"it is not a solution; solving gives {shown}", "symbolic"
        return UNCHECKABLE, "could not compare it with the solutions SymPy found", "none"
    if len(solutions) > 1:
        return (
            UNCHECKABLE,
            f"it is one of {len(solutions)} solutions, and nothing stated rules the others out",
            "symbolic",
        )
    return PASS, "it is the only solution", "symbolic"


OPERATIONS = {
    **dict.fromkeys(("rewrite", "simplify", "expand", "factor", "rearrange", "collect"), rewrite),
    "add": both_sides(lambda side, value: side + value),
    "subtract": both_sides(lambda side, value: side - value),
    "multiply": both_sides(lambda side, value: side * value),
    "power": both_sides(lambda side, value: side**value),
    "divide": divide,
    "apply": apply_function,
    "substitute": substitute,
    "differentiate": differentiate,
    "integrate": integrate,
    "add-equations": combine(1),
    "subtract-equations": combine(-1),
    "solve": solve,
}


def check_step(raw, previous, known, symbols):
    """Returns (statement or None, status, reason, method)."""
    try:
        stated = read_statement(raw["statement"], symbols)
    except Unreadable as error:
        return None, UNCHECKABLE, f"could not read the statement: {error}", "none"

    def lookup(key, default=None):
        name = raw.get(key, default)
        if name is None:
            return None
        if name not in known:
            raise Unreadable(f"`{key}` names {name}, which is not an earlier statement")
        if known[name] is None:
            raise Unreadable(f"it depends on {name}, which could not be read")
        return known[name]

    try:
        source = lookup("from", previous)
        if source is None:
            raise Unreadable("there is nothing for this step to follow from")
        handler = OPERATIONS.get(raw["operation"].strip().lower())
        if handler is None:
            return (
                stated,
                UNCHECKABLE,
                f"no checker for the operation '{raw['operation']}'",
                "none",
            )
        return stated, *handler(Step(raw, stated, source, lookup("using"), symbols))
    except Unreadable as error:
        return stated, UNCHECKABLE, str(error), "none"
    except Exception as error:
        return stated, UNCHECKABLE, f"the checker failed: {type(error).__name__}: {error}", "none"


def check_derivation(derivation, emit):
    symbols = {
        name: sympy.Symbol(name, **dict.fromkeys(spec.get("assumptions") or (), True))
        for name, spec in (derivation.get("symbols") or {}).items()
    }
    known = {}
    previous = None

    def rendered(statement):
        latex, mathml = statement.render() if statement else (None, None)
        return {"latex": latex, "mathml": mathml}

    for given in derivation["given"]:
        statement, problem = None, None
        if given["id"] in known:
            problem = "this id is already used by an earlier statement"
        else:
            try:
                statement = read_statement(given["statement"], symbols)
            except Unreadable as error:
                problem = f"could not read the statement: {error}"
            known[given["id"]] = statement
            previous = given["id"]
        emit({"given": {"id": given["id"], "problem": problem, **rendered(statement)}})

    for raw in derivation["steps"]:
        if raw["id"] in known:
            statement, status, reason, method = (
                None,
                UNCHECKABLE,
                "this id is already used by an earlier statement",
                "none",
            )
        else:
            statement, status, reason, method = check_step(raw, previous, known, symbols)
            known[raw["id"]] = statement
            previous = raw["id"]
        emit(
            {
                "step": {
                    "id": raw["id"],
                    "status": status,
                    "reason": reason,
                    "method": method,
                    **rendered(statement),
                }
            }
        )


HANDLERS = {"derivation": lambda request, emit: check_derivation(request["derivation"], emit)}


def main():
    with open("input.json", encoding="utf-8") as source:
        requests = json.load(source)["requests"]
    for index, request in enumerate(requests):

        def emit(finding, index=index):
            print(json.dumps({"request": index, **finding}), flush=True)

        try:
            HANDLERS[request["kind"]](request, emit)
            emit({"done": True})
        except Exception as error:  # one bad request must not silence the rest
            emit({"error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
