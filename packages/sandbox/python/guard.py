"""Sheep sandbox guard: the first code to run in the script's own process.

It prepares the interpreter, then runs the script as `__main__`. Everything
here happens before a line of the script does.
"""

import sys
import traceback


def execute(entry):
    sys.argv = [entry]
    scope = {"__name__": "__main__", "__file__": entry, "__builtins__": __builtins__}
    try:
        with open(entry, "rb") as source:
            code = compile(source.read(), entry, "exec")
        exec(code, scope)
    except SystemExit:
        raise
    except BaseException as error:
        # The traceback starts at the script: frames from this file are not
        # something the author of the script can act on.
        frame = error.__traceback__
        while frame is not None and frame.tb_frame.f_code.co_filename != entry:
            frame = frame.tb_next
        traceback.print_exception(type(error), error, frame)
        sys.exit(1)


def main():
    # One newline convention on every platform, so recorded output is the same
    # bytes wherever the run happened.
    sys.stdout.reconfigure(newline="\n")
    sys.stderr.reconfigure(newline="\n")
    execute(sys.argv[1])


if __name__ == "__main__":
    main()
