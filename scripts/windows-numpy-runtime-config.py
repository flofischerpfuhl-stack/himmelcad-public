"""Runtime build inventory for HimmelCAD's Windows NumPy 2.2.6 wheel."""

from enum import Enum

from numpy._core._multiarray_umath import (
    __cpu_baseline__,
    __cpu_dispatch__,
    __cpu_features__,
)

__all__ = ["show_config"]
_built_with_meson = True


class DisplayModes(Enum):
    stdout = "stdout"
    dicts = "dicts"


CONFIG = {
    "Compilers": {
        "numpy extensions": {
            "name": "msvc",
            "version": "19.29.30159",
        },
        "reference BLAS/LAPACK provider": {
            "name": "LLVM-MinGW clang",
            "language": "C",
        },
    },
    "Machine Information": {
        "host": {
            "cpu": "x86_64",
            "family": "x86_64",
            "endian": "little",
            "system": "windows",
        },
        "cross-compiled provider": True,
    },
    "Build Dependencies": {
        "blas": {
            "name": "himmelcad-reference-f2c",
            "found": True,
            "integer ABI": "ILP64",
            "threading": "none",
        },
        "lapack": {
            "name": "himmelcad-reference-f2c",
            "found": True,
            "integer ABI": "ILP64",
            "threading": "none",
        },
    },
    "Python Information": {"version": "3.12"},
    "SIMD Extensions": {
        "baseline": __cpu_baseline__,
        "found": [name for name in __cpu_dispatch__ if __cpu_features__[name]],
        "not found": [name for name in __cpu_dispatch__ if not __cpu_features__[name]],
    },
}


def show(mode=DisplayModes.stdout.value):
    """Show libraries and system information used by this NumPy runtime."""
    if mode == DisplayModes.dicts.value:
        return CONFIG
    if mode != DisplayModes.stdout.value:
        raise AttributeError(
            f"Invalid `mode`, use one of: {', '.join(item.value for item in DisplayModes)}"
        )
    try:
        import yaml
    except ModuleNotFoundError:
        import json

        print(json.dumps(CONFIG, indent=2))
    else:
        print(yaml.dump(CONFIG))


def show_config(mode=DisplayModes.stdout.value):
    return show(mode)


show_config.__doc__ = show.__doc__
show_config.__module__ = "numpy"
