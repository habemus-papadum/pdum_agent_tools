"""Test-only coverage entry point for the real isolated namespace helper.

The helper still performs the real syscalls and exec. Save observations before
exec and unavoidable scope death; SIGKILL-only paths can remain unmeasured.
Production launch never imports this file or coverage.
"""

import os
import runpy
import signal
from pathlib import Path

import coverage

helper = Path(os.environ["PDUM_HOSTFORK_TEST_REAL_HELPER"])
collector = coverage.Coverage(
    config_file=False,
    data_file=os.environ["PDUM_HOSTFORK_TEST_COVERAGE_FILE"],
    data_suffix=True,
    source=[str(helper.parent)],
    branch=os.environ.get("PDUM_HOSTFORK_TEST_COVERAGE_BRANCH") == "1",
)
collector.start()
implementation = runpy.run_path(str(helper), run_name="hostfork_instrumented_helper")
execvpe, write = os.execvpe, os.write


def observed_exec(*args):
    collector.save()
    return execvpe(*args)


def observed_write(descriptor, data):
    if data == b"1":
        # The keeper's whole-scope kill necessarily terminates this interpreter.
        collector.save()
    return write(descriptor, data)


def terminating(number, frame):
    collector.save()
    signal.signal(number, signal.SIG_DFL)
    os.kill(os.getpid(), number)


os.execvpe = observed_exec
os.write = observed_write
signal.signal(signal.SIGTERM, terminating)
try:
    implementation["main"]()
finally:
    collector.stop()
    collector.save()
