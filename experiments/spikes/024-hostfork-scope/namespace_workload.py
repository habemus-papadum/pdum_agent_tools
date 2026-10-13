"""Launch the mixed-library fixture through the existing namespace experiment."""

import asyncio
import sys
from pathlib import Path

from hostfork_scope_spike.scoped_process import save
from hostfork_spike import Environment, EnvironmentSpec, Mount


async def main(root: Path) -> None:
    view = root / "view"
    spec = EnvironmentSpec(
        mounts=[Mount("overlay", str(view)), Mount("fresh", "/dev/shm")],
        deadline_seconds=20,
        retain_on_owner_exit=True,
    )
    environment = await Environment.create(spec, artifact_root=root / "inner")
    try:
        save(root / "inner-location.json", {"path": str(environment.path)})
        result = await environment.run(
            [sys.executable, "-c", "from pathlib import Path; Path('data').write_text('private write\\n')"],
            cwd=str(view),
        )
        assert result["returncode"] == 0
        process = await environment.spawn(
            [
                sys.executable,
                str(Path(__file__).with_name("workloads.py")),
                "tree",
                "--artifacts",
                str(root / "workload"),
                "--duration",
                "20",
            ]
        )
        await process.wait()
    finally:
        await environment.close()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
