"""Sheep verification checker.

Runs inside the sandbox. Reads `input.json` — a list of requests — and prints
one JSON line per finding as it reaches it, so a checker that runs out of time
has still said everything it managed to decide.

Nothing here asks a language model anything. A step passes because SymPy
reduced a difference to zero, or fails because it did not — or because the two
sides came to different numbers at a sampled point — or is reported as
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
import random
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


SAMPLES = 12


def draw(symbol, rng):
    """A value for a symbol that respects what was assumed of it."""
    if symbol.is_integer:
        low = 1 if symbol.is_positive else -6
        high = -1 if symbol.is_negative else 6
        value = rng.randint(low, high)
        return sympy.Integer(value if value or not symbol.is_nonzero else 1)
    magnitude = rng.uniform(0.2, 4.0)
    if symbol.is_negative or not (symbol.is_positive or symbol.is_nonnegative or rng.random() < 0.5):
        magnitude = -magnitude
    return sympy.Float(magnitude, 30)


def spot_check(left, right):
    """Tries to show two expressions differ by evaluating them at random points.

    Cheap, and decisive in one direction only: a single point at which the two
    disagree proves they are not identical, while agreeing at every point
    proves nothing. Returns (counterexample or None, points evaluated).

    Seeded, so a verdict is the same verdict on every run.
    """
    if left.has(sympy.Derivative, sympy.Integral) or right.has(sympy.Derivative, sympy.Integral):
        return None, 0
    rng = random.Random(0)
    symbols = sorted(left.free_symbols | right.free_symbols, key=str)
    evaluated = 0
    for _ in range(SAMPLES if symbols else 1):
        point = {symbol: draw(symbol, rng) for symbol in symbols}
        try:
            # SymPy's own numbers, not floats: a value like 5**9999 is far past
            # what a float can hold and is still perfectly comparable.
            a = left.xreplace(point).evalf(30)
            b = right.xreplace(point).evalf(30)
            if not (a.is_number and b.is_number and a.is_finite and b.is_finite):
                continue  # undefined here: a pole, or outside a function's domain
            differs = bool(abs(a - b) > sympy.Float("1e-9") * (1 + abs(a) + abs(b)))
        except Exception:
            continue
        evaluated += 1
        if differs:
            shown = {str(thaw(symbol)): f"{float(value):.6g}" for symbol, value in point.items()}
            return {**shown, "left": show_number(a), "right": show_number(b)}, evaluated
    return None, evaluated


def show_number(value):
    return sympy.sstr(sympy.N(value, 6))


def identical(left, right):
    """Whether two expressions are the same for every value of their symbols."""
    difference = left - right
    if difference == 0:
        return PASS, "both sides are the same expression", "structural"

    # Numbers first. Falsifying an identity takes one evaluation; proving one
    # can take SymPy minutes, and there is no point proving what is false.
    counterexample, evaluated = spot_check(left, right)
    if counterexample is not None:
        where = ", ".join(
            f"{name} = {value}"
            for name, value in counterexample.items()
            if name not in ("left", "right")
        )
        reason = (
            f"it gives {counterexample['left']} where the operation gives {counterexample['right']}"
            + (f", at {where}" if where else "")
        )
        return FAIL, reason, "numeric", counterexample

    try:
        reduced = sympy.simplify(difference)
        if reduced == 0:
            return PASS, "the difference simplifies to zero", "symbolic"
        equal = reduced.equals(0)
    except Exception as error:
        return UNCHECKABLE, f"SymPy could not work on it: {type(error).__name__}: {error}", "none"
    if equal:
        return PASS, "the difference is zero", "symbolic"
    # SymPy's own "not equal" comes from sampling at points of its choosing,
    # complex ones included, whatever was assumed of the symbols — and it is
    # sometimes wrong about identities that hold for reals. It is believed only
    # when the sampling above, which does respect the assumptions, had nothing
    # to say. Twelve agreeing points outrank it.
    if equal is False and evaluated == 0:
        return FAIL, f"it differs from what the operation gives by {sympy.sstr(reduced)}", "symbolic"
    # Agreement at sampled points is evidence, not proof, and is reported as
    # exactly that.
    agreed = f"it agrees at all {evaluated} points sampled, but " if evaluated else ""
    return (
        UNCHECKABLE,
        f"{agreed}SymPy could not prove that {sympy.sstr(reduced)} is zero",
        "numeric" if evaluated else "none",
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
    """Returns (statement or None, status, reason, method[, counterexample])."""
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


# ── Dimensions ──────────────────────────────────────────────────────────────

_registry = None


def registry():
    """pint's unit registry, built on first use: most derivations declare no units."""
    global _registry
    if _registry is None:
        import pint

        _registry = pint.UnitRegistry(cache_folder=None)
    return _registry


class Inconsistent(Exception):
    """An expression that adds, compares or exponentiates unlike quantities."""


class Undeclared(Exception):
    """A symbol with no units to go on."""


# Zero is zero metres and zero seconds alike: it fits whatever it is compared with.
ANY = object()

DIMENSION_PRESERVING = (
    sympy.Abs,
    sympy.re,
    sympy.im,
    sympy.conjugate,
    sympy.floor,
    sympy.ceiling,
    sympy.Min,
    sympy.Max,
)


def same(left, right):
    """Equal as dimensions. Exponents are compared with a tolerance: a cube
    root cubed is 0.333... three times over, and still a whole power."""
    return all(
        abs(left.get(key, 0) - right.get(key, 0)) < 1e-9 for key in set(left) | set(right)
    )


def show(dimension):
    return str(dimension) if any(abs(power) > 1e-9 for power in dimension.values()) else "dimensionless"


class Dimensions:
    """Works out what kind of quantity an expression is, from its symbols' units."""

    def __init__(self, declared):
        self.none = registry().parse_units("").dimensionality
        self.units = {}
        for name, text in declared.items():
            try:
                self.units[name] = registry().parse_units(text).dimensionality
            except Exception:
                raise Unreadable(f"the units of {name} could not be read: {text}") from None

    def common(self, parts, verb):
        found = [dimension for dimension in map(self.of, parts) if dimension is not ANY]
        for dimension in found[1:]:
            if not same(dimension, found[0]):
                raise Inconsistent(f"it {verb} {show(found[0])} and {show(dimension)}")
        return found[0] if found else ANY

    def pure(self, expression, what):
        dimension = self.of(expression)
        if dimension is not ANY and not same(dimension, self.none):
            raise Inconsistent(f"{what} has to be dimensionless, but is {show(dimension)}")

    def of(self, expression):
        if expression.is_zero:
            return ANY
        if expression.is_number:
            return self.none
        if expression.is_Symbol:
            if expression in _RATES:
                return self.of(_RATES[expression])
            if expression.name not in self.units:
                raise Undeclared(expression.name)
            return self.units[expression.name]
        if expression.is_Add:
            return self.common(expression.args, "adds")
        if expression.is_Mul:
            product = self.none
            for factor in expression.args:
                dimension = self.of(factor)
                if dimension is ANY:
                    return ANY
                product = product * dimension
            return product
        if expression.is_Pow:
            base, exponent = expression.args
            if exponent.is_number:
                dimension = self.of(base)
                if dimension is ANY:
                    return ANY
                return dimension ** (int(exponent) if exponent.is_Integer else float(exponent))
            self.pure(exponent, "an exponent")
            self.pure(base, "the base of a symbolic power")
            return self.none
        if isinstance(expression, sympy.Derivative):
            dimension = self.of(expression.expr)
            for variable, count in expression.variable_count:
                dimension = dimension / self.of(variable) ** int(count)
            return dimension
        if isinstance(expression, sympy.Integral):
            dimension = self.of(expression.function)
            for limit in expression.limits:
                dimension = dimension * self.of(limit[0])
            return dimension
        if isinstance(expression, DIMENSION_PRESERVING):
            return self.common(expression.args, "compares")
        if expression.is_Function:
            for argument in expression.args:
                self.pure(argument, f"the argument of {expression.func.__name__}")
            return self.none
        raise Undeclared(sympy.sstr(expression))

    def check(self, statement):
        try:
            sides = [side for side in map(self.of, statement.sides) if side is not ANY]
        except Inconsistent as error:
            return FAIL, str(error)
        except Undeclared as error:
            return UNCHECKABLE, f"no units are declared for {error}"
        if not sides:
            return PASS, "zero fits any dimension"
        if len(sides) == 2 and not same(*sides):
            return (
                FAIL,
                f"the left side is {show(sides[0])} but the right side is {show(sides[1])}",
            )
        return PASS, ("both sides are " if statement.is_equation else "it is ") + show(sides[0])


def check_units(request, emit):
    """Whether each reported quantity is the kind of quantity it was expected to be."""
    for item in request["quantities"]:
        finding = {"name": item["name"], "factor": None}
        units, expected = item["units"], item["expected"]
        try:
            have, want = registry().parse_units(units), registry().parse_units(expected)
        except Exception as error:
            reason = f"the units could not be read: {error}"
            emit({"quantity": {**finding, "status": UNCHECKABLE, "reason": reason}})
            continue
        if not same(have.dimensionality, want.dimensionality):
            reason = (
                f"{units} is {show(have.dimensionality)}, "
                f"but {expected} is {show(want.dimensionality)}"
            )
            emit({"quantity": {**finding, "status": FAIL, "reason": reason}})
            continue
        try:
            factor = float(registry().Quantity(1, have).to(want).magnitude)
            reason = f"1 {units} = {factor:g} {expected}"
        except Exception:
            factor, reason = None, "the same kind of quantity, on a scale with an offset"
        emit({"quantity": {**finding, "status": PASS, "reason": reason, "factor": factor}})


# ── Constraints ─────────────────────────────────────────────────────────────

SOLVER_TIMEOUT_MS = 10_000

COMPARISONS = {
    ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b,
    ast.Gt: lambda a, b: a > b,
    ast.GtE: lambda a, b: a >= b,
    ast.Eq: lambda a, b: a == b,
    ast.NotEq: lambda a, b: a != b,
}


def read_constraint(source, variables):
    """Builds a Z3 formula from text, by the same rule as `read_expression`:
    the syntax tree is walked, and only what is listed here is understood."""
    import z3

    def real(term):
        return z3.ToReal(term) if z3.is_int(term) else term

    logic = {
        "And": z3.And,
        "Or": z3.Or,
        "Not": z3.Not,
        "Implies": z3.Implies,
        "Abs": lambda x: z3.If(x >= 0, x, -x),
        "Min": lambda a, b: z3.If(a <= b, a, b),
        "Max": lambda a, b: z3.If(a >= b, a, b),
    }

    def build(node):
        if isinstance(node, ast.Constant):
            value = node.value
            if type(value) is bool:
                return z3.BoolVal(value)
            if type(value) is int:
                return z3.IntVal(value)
            if type(value) is float:
                return z3.RealVal(repr(value))
            raise Unreadable("only numbers and True/False may appear as literals")
        if isinstance(node, ast.Name):
            if node.id not in variables:
                raise Unreadable(f"{node.id} is not a declared variable")
            return variables[node.id]
        if isinstance(node, ast.UnaryOp):
            operand = build(node.operand)
            if isinstance(node.op, ast.Not):
                return z3.Not(operand)
            if isinstance(node.op, ast.USub):
                return -operand
            if isinstance(node.op, ast.UAdd):
                return operand
        if isinstance(node, ast.BinOp):
            left, right = build(node.left), build(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                # Z3 divides integers by truncating. A claim that writes x/2
                # means half of x.
                return real(left) / real(right)
            if isinstance(node.op, ast.Pow):
                return left**right
            raise Unreadable(f"the operator {type(node.op).__name__} is not allowed")
        if isinstance(node, ast.BoolOp):
            parts = [build(value) for value in node.values]
            return z3.And(*parts) if isinstance(node.op, ast.And) else z3.Or(*parts)
        if isinstance(node, ast.Compare):
            terms = [build(node.left), *(build(term) for term in node.comparators)]
            links = []
            for operator, left, right in zip(node.ops, terms, terms[1:]):
                if type(operator) not in COMPARISONS:
                    raise Unreadable(f"the comparison {type(operator).__name__} is not allowed")
                links.append(COMPARISONS[type(operator)](left, right))
            return z3.And(*links) if len(links) > 1 else links[0]
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in logic or node.keywords:
                raise Unreadable("only And, Or, Not, Implies, Abs, Min and Max may be called")
            return logic[node.func.id](*(build(argument) for argument in node.args))
        raise Unreadable(f"{type(node).__name__} is not allowed in a constraint")

    try:
        formula = build(ast.parse(source.strip(), mode="eval").body)
    except SyntaxError as error:
        raise Unreadable(f"not a constraint: {error.msg}") from None
    except Unreadable:
        raise
    except Exception as error:  # a sort mismatch: adding a number to a boolean
        raise Unreadable(f"{type(error).__name__}: {error}") from None
    if not z3.is_bool(formula):
        raise Unreadable("a constraint has to be true or false, not a number")
    return formula


def check_constraints(request, emit):
    """Whether each claim holds in every case its assumptions allow.

    Z3 is asked for a case where the assumptions hold and the claim does not.
    If there is provably none, the claim is proved. If it finds one, that case
    is the counterexample. If it gives up, the claim is undecided.
    """
    import z3

    sorts = {"real": z3.Real, "int": z3.Int, "bool": z3.Bool}
    for claim in request["claims"]:
        finding = {"name": claim["name"], "counterexample": None}

        def answer(status, reason, **extra):
            emit({"constraint": {**finding, "status": status, "reason": reason, **extra}})

        try:
            variables = {name: sorts[sort](name) for name, sort in claim["variables"].items()}
            assumptions = [read_constraint(text, variables) for text in claim["assumptions"]]
            goal = read_constraint(claim["claim"], variables)
        except Unreadable as error:
            answer(UNCHECKABLE, f"could not read it: {error}")
            continue

        solver = z3.Solver()
        solver.set("timeout", SOLVER_TIMEOUT_MS)
        solver.add(*assumptions)
        # A claim proved from assumptions that cannot all hold is proved from
        # nothing: everything follows from a contradiction.
        consistent = solver.check()
        if consistent == z3.unsat:
            answer(FAIL, "the assumptions contradict each other, so nothing can be concluded from them")
            continue

        solver.add(z3.Not(goal))
        outcome = solver.check()
        if outcome == z3.unsat:
            if consistent == z3.sat:
                answer(PASS, "there is no case in which the assumptions hold and the claim does not")
            else:
                answer(UNCHECKABLE, "the claim follows, but Z3 could not confirm the assumptions can hold")
        elif outcome == z3.sat:
            model = solver.model()
            case = {name: str(model.eval(variable, model_completion=True)) for name, variable in variables.items()}
            shown = ", ".join(f"{name} = {value}" for name, value in case.items())
            answer(FAIL, f"it does not hold when {shown}", counterexample=case)
        else:
            answer(UNCHECKABLE, f"Z3 could not decide it: {solver.reason_unknown()}")


# ── Statistics ──────────────────────────────────────────────────────────────


def recompute_p(test, tails):
    """The p-value a reported test statistic actually implies, or None."""
    from scipy import stats

    kind, statistic, df = test.get("test"), test.get("statistic"), test.get("df")
    if kind is None or statistic is None:
        return None
    if kind == "z":
        upper = stats.norm.sf(abs(statistic))
    elif kind == "t" and df:
        upper = stats.t.sf(abs(statistic), df)
    elif kind == "r" and df and abs(statistic) < 1:
        upper = stats.t.sf(abs(statistic) * (df / (1 - statistic**2)) ** 0.5, df)
    elif kind == "chi2" and df:
        return float(stats.chi2.sf(statistic, df))
    elif kind == "f" and df and test.get("df2"):
        return float(stats.f.sf(statistic, df, test["df2"]))
    else:
        return None
    return float(upper * tails)


def describe_test(test):
    kind, statistic = test["test"], test["statistic"]
    df = [str(test[key]) for key in ("df", "df2") if test.get(key)]
    return f"{kind}{'(' + ', '.join(df) + ')' if df else ''} = {statistic:g}"


def power_for(effect, sizes, alpha, tails):
    """Chance that a design this size detects a standardised difference this big."""
    from scipy import stats

    if len(sizes) == 2:
        df, scale = sum(sizes) - 2, (sizes[0] * sizes[1] / sum(sizes)) ** 0.5
    else:
        df, scale = sizes[0] - 1, sizes[0] ** 0.5
    if df < 1:
        return None
    critical = stats.t.isf(alpha / tails, df)
    noncentrality = abs(effect) * scale
    power = stats.nct.sf(critical, df, noncentrality)
    if tails == 2:
        power += stats.nct.cdf(-critical, df, noncentrality)
    return float(power)


def adjust(p_values, comparisons, method):
    """Adjusted p-values, in the order given.

    `comparisons` may exceed the number of p-values reported. The tests nobody
    reported are treated as the least significant: they still count towards
    how many were run.
    """
    order = sorted(range(len(p_values)), key=lambda index: p_values[index])
    adjusted = [1.0] * len(p_values)
    if method == "bonferroni":
        return [min(1.0, p * comparisons) for p in p_values]
    if method == "holm":
        running = 0.0
        for rank, index in enumerate(order):
            running = max(running, min(1.0, (comparisons - rank) * p_values[index]))
            adjusted[index] = running
        return adjusted
    # Benjamini-Hochberg, stepping up from the least significant.
    running = 1.0
    for rank in range(len(order) - 1, -1, -1):
        index = order[rank]
        running = min(running, p_values[index] * comparisons / (rank + 1))
        adjusted[index] = running
    return adjusted


def audit_report(report):
    """Yields (check, subject, status, reason) for one reported analysis."""
    from scipy import stats

    alpha = report.get("alpha", 0.05)
    tests = report["tests"]
    sizes = [group["n"] for group in report.get("groups") or []] or (
        [report["n"]] if report.get("n") else []
    )

    # How many observations. Without it nothing else here can be weighed.
    if not sizes:
        yield "sample-size", None, FAIL, "no sample size is reported"
    else:
        shown = " + ".join(str(size) for size in sizes)
        yield "sample-size", None, PASS, f"n = {shown}"

    for test in tests:
        name, tails = test["name"], test.get("tails", 2)
        p, effect, interval = test.get("p"), test.get("effect"), test.get("ci")

        # A p-value says an effect is unlikely to be zero, not how big it is.
        if effect is None:
            yield "effect-size", name, FAIL, "no effect size is reported, only whether there is one"
        else:
            yield "effect-size", name, PASS, f"{effect['kind']} = {effect['value']:g}"

        # Was the study big enough to find an effect of the size it reports? A
        # significant result from a design that would usually miss it is more
        # likely an overestimate than a discovery.
        if effect is None or effect["kind"] != "d":
            yield "power", name, UNCHECKABLE, "power is computed for a standardised mean difference (d) only"
        elif not sizes or len(sizes) > 2:
            yield "power", name, UNCHECKABLE, "power needs one or two group sizes"
        else:
            power = power_for(effect["value"], sizes, alpha, tails)
            if power is None:
                yield "power", name, UNCHECKABLE, "the groups are too small to compute power"
            else:
                detail = f"a design of this size detects d = {effect['value']:g} {power:.0%} of the time"
                yield "power", name, (PASS if power >= 0.5 else FAIL), detail

        if interval is None:
            yield "confidence-interval", name, FAIL, "no confidence interval is reported"
        else:
            low, high, null = interval["low"], interval["high"], interval.get("null", 0)
            excludes = not (low <= null <= high)
            if low > high:
                yield "confidence-interval", name, FAIL, f"the interval [{low:g}, {high:g}] is upside down"
            elif effect is not None and not (low <= effect["value"] <= high):
                detail = f"the estimate {effect['value']:g} lies outside its own interval [{low:g}, {high:g}]"
                yield "confidence-interval", name, FAIL, detail
            elif p is not None and abs(interval["level"] - (1 - alpha)) < 1e-9 and excludes != (p < alpha):
                side = "excludes" if excludes else "contains"
                detail = (
                    f"the {interval['level']:.0%} interval {side} {null:g}, "
                    f"which contradicts p = {p:g} at alpha = {alpha:g}"
                )
                yield "confidence-interval", name, FAIL, detail
            else:
                yield "confidence-interval", name, PASS, f"[{low:g}, {high:g}] at {interval['level']:.0%}"

        # The reported p against the one the reported statistic implies.
        if p is None:
            yield "p-value", name, UNCHECKABLE, "no p-value is reported"
        else:
            implied = recompute_p(test, tails)
            if implied is None:
                yield "p-value", name, UNCHECKABLE, "no test statistic to recompute it from"
            else:
                gap = abs(implied - p)
                flips = (implied < alpha) != (p < alpha) and gap > 0.0005
                if flips or gap > max(0.005, 0.05 * implied):
                    detail = f"reported p = {p:g}, but {describe_test(test)} gives p = {implied:.3g}"
                    if flips:
                        detail += ", which changes whether it is significant"
                    yield "p-value", name, FAIL, detail
                else:
                    yield "p-value", name, PASS, f"{describe_test(test)} gives p = {implied:.3g}, as reported"

    reported = [(test["name"], test["p"]) for test in tests if test.get("p") is not None]
    comparisons = max(report.get("comparisons", 0), len(tests))
    correction = report.get("correction", "none")

    # Twenty tests at alpha = 0.05 produce one "finding" from noise alone.
    if comparisons < 2:
        yield "multiple-comparisons", None, PASS, "one comparison; nothing to correct for"
    elif not reported:
        yield "multiple-comparisons", None, UNCHECKABLE, "no p-values to correct"
    else:
        method = "holm" if correction == "none" else correction
        adjusted = adjust([p for _, p in reported], comparisons, method)
        lost = [
            f"{name} (p = {p:g}, adjusted {corrected:.3g})"
            for (name, p), corrected in zip(reported, adjusted)
            if p < alpha <= corrected
        ]
        applied = "no correction was applied; under Holm" if correction == "none" else f"under {correction}"
        if lost:
            detail = f"{comparisons} comparisons, and {applied} these are no longer significant: {'; '.join(lost)}"
            yield "multiple-comparisons", None, FAIL, detail
        elif correction == "none":
            detail = f"{comparisons} comparisons with no correction, though every significant result survives Holm"
            yield "multiple-comparisons", None, PASS, detail
        else:
            yield "multiple-comparisons", None, PASS, f"{comparisons} comparisons, corrected with {correction}"

    # The shape of the significant p-values. A real effect piles them up near
    # zero; results nudged across the line pile up just under alpha instead.
    significant = [p for _, p in reported if p < alpha]
    if len(significant) < 5:
        detail = f"{len(significant)} significant p-values; a shape needs at least 5"
        yield "p-curve", None, UNCHECKABLE, detail
    else:
        near = sum(p > alpha / 2 for p in significant)
        chance = float(stats.binomtest(near, len(significant), 0.5, alternative="greater").pvalue)
        detail = (
            f"{near} of {len(significant)} significant p-values fall in the half nearest "
            f"alpha ({alpha / 2:g} to {alpha:g})"
        )
        if chance < 0.05:
            yield "p-curve", None, FAIL, f"{detail}; that many by chance has probability {chance:.3g}"
        else:
            yield "p-curve", None, PASS, detail


def audit_statistics(request, emit):
    for index, report in enumerate(request["reports"]):
        try:
            for check, subject, status, reason in audit_report(report):
                emit(
                    {
                        "finding": {
                            "report": index,
                            "check": check,
                            "subject": subject,
                            "status": status,
                            "reason": reason,
                        }
                    }
                )
        except Exception as error:
            emit(
                {
                    "finding": {
                        "report": index,
                        "check": "audit",
                        "subject": None,
                        "status": UNCHECKABLE,
                        "reason": f"the audit failed: {type(error).__name__}: {error}",
                    }
                }
            )
        emit({"audited": index})


def check_derivation(derivation, emit):
    symbols = {
        name: sympy.Symbol(name, **dict.fromkeys(spec.get("assumptions") or (), True))
        for name, spec in (derivation.get("symbols") or {}).items()
    }
    known = {}
    previous = None

    declared = {
        name: spec["units"]
        for name, spec in (derivation.get("symbols") or {}).items()
        if spec.get("units") is not None
    }
    try:
        dimensions = Dimensions(declared) if declared else None
    except Unreadable as error:
        dimensions = str(error)

    def dimensional(statement):
        """None when the derivation declares no units: the check was not asked for."""
        if dimensions is None or statement is None:
            return None
        if isinstance(dimensions, str):
            return {"status": UNCHECKABLE, "reason": dimensions}
        try:
            status, reason = dimensions.check(statement)
        except Exception as error:
            status, reason = UNCHECKABLE, f"the dimensional check failed: {error}"
        return {"status": status, "reason": reason}

    def rendered(statement):
        latex, mathml = statement.render() if statement else (None, None)
        return {"latex": latex, "mathml": mathml, "dimensions": dimensional(statement)}

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
            statement, status, reason, method, *found = (
                None,
                UNCHECKABLE,
                "this id is already used by an earlier statement",
                "none",
            )
        else:
            statement, status, reason, method, *found = check_step(raw, previous, known, symbols)
            known[raw["id"]] = statement
            previous = raw["id"]
        shown = rendered(statement)
        # A step can follow algebraically and still equate a length to a time.
        if status != FAIL and shown["dimensions"] and shown["dimensions"]["status"] == FAIL:
            status, method = FAIL, "dimensional"
            reason = "dimensionally inconsistent: " + shown["dimensions"]["reason"]
        emit(
            {
                "step": {
                    "id": raw["id"],
                    "status": status,
                    "reason": reason,
                    "method": method,
                    "counterexample": found[0] if found and status == FAIL else None,
                    **shown,
                }
            }
        )


HANDLERS = {
    "derivation": lambda request, emit: check_derivation(request["derivation"], emit),
    "units": check_units,
    "constraints": check_constraints,
    "statistics": audit_statistics,
}


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
