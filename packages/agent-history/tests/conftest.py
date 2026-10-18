"""Let test modules import their siblings' fixture builders under pytest's importlib import mode."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
