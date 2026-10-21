"""Save a scratch evaluation's diff without creating or changing a Git repository."""

import argparse
import json
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.run_dir / "run.json").read_text())
    fixture = Path(__file__).resolve().parents[2] / "evals/tasks/hp-mini/fixture"
    worktree = Path(manifest["worktree"])
    result = subprocess.run(
        ["git", "diff", "--no-index", "--binary", str(fixture), str(worktree)], text=True, capture_output=True
    )
    if result.returncode not in (0, 1):
        raise SystemExit(result.stderr)
    (args.run_dir / "worktree.patch").write_text(result.stdout)
    changed = []
    for file in sorted(worktree.rglob("*")):
        if file.is_file():
            original = fixture / file.relative_to(worktree)
            if not original.exists() or original.read_bytes() != file.read_bytes():
                changed.append(str(file.relative_to(worktree)))
    (args.run_dir / "status.txt").write_text("\n".join(changed) + "\n")
    print(json.dumps({"run_id": manifest["run_id"], "changed": changed}))


if __name__ == "__main__":
    main()
