"""Small async systemd D-Bus client with real Unix descriptor passing."""

import asyncio
import os
import select
import time

from dbus_next import Message, MessageType, Variant
from dbus_next.aio import MessageBus


class ManagerError(RuntimeError):
    """The service manager rejected an operation."""


class Manager:
    def __init__(self):
        self.bus = None
        self.references: set[str] = set()
        self._connect_lock = asyncio.Lock()

    async def call(self, member, signature, body, fds=None, *, path="/org/freedesktop/systemd1", interface=None):
        if self.bus is None:
            async with self._connect_lock:
                if self.bus is None:
                    address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{os.getuid()}/bus")
                    candidate = MessageBus(bus_address=address, negotiate_unix_fd=True)
                    try:
                        self.bus = await asyncio.wait_for(candidate.connect(), 5)
                    except BaseException:
                        await self._dispose(candidate)
                        raise
        reply = await asyncio.wait_for(
            self.bus.call(
                Message(
                    destination="org.freedesktop.systemd1",
                    path=path,
                    interface=interface or "org.freedesktop.systemd1.Manager",
                    member=member,
                    signature=signature,
                    body=body,
                    unix_fds=fds or [],
                )
            ),
            5,
        )
        if reply.message_type == MessageType.ERROR:
            raise ManagerError(f"{reply.error_name}: {reply.body}")
        return reply.body

    async def start(
        self,
        unit: str,
        descriptor: int,
        *,
        runtime: float | None,
        grace: float,
        delegate=False,
        memory_bytes=None,
        cpu_cores=None,
    ) -> dict:
        properties = [
            ["PIDFDs", Variant("ah", [0])],
            ["AddRef", Variant("b", True)],
            ["KillMode", Variant("s", "control-group")],
            ["TimeoutStopUSec", Variant("t", max(1, int(grace * 1_000_000)))],
            ["CPUAccounting", Variant("b", True)],
            ["MemoryAccounting", Variant("b", True)],
        ]
        if runtime is not None:
            properties.append(["RuntimeMaxUSec", Variant("t", max(1, int(runtime * 1_000_000)))])
        if delegate:
            properties.append(["Delegate", Variant("b", True)])
        if memory_bytes is not None:
            properties.extend(
                [
                    ["MemoryMax", Variant("t", memory_bytes)],
                    ["MemorySwapMax", Variant("t", 0)],
                    ["OOMPolicy", Variant("s", "kill")],
                ]
            )
        if cpu_cores is not None:
            properties.append(["CPUQuotaPerSecUSec", Variant("t", int(cpu_cores * 1_000_000))])
        await self.call("StartTransientUnit", "ssa(sv)a(sa(sv))", [unit, "fail", properties, []], [descriptor])
        self.references.add(unit)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            state = await self.inspect(unit)
            if state.get("ActiveState") == "active" and state.get("ActiveEnterTimestampMonotonic", 0) > 0:
                return state
            # StartTransientUnit acknowledges the queued job, not activation.
            # A newly loaded scope may briefly be inactive while the job runs.
            # The unreleased helper must remain alive; its pidfd avoids treating
            # an initial inactive property snapshot as completed execution.
            if state.get("ActiveState") == "failed" or select.select([descriptor], [], [], 0)[0]:
                raise ManagerError(f"Scope failed during activation: {state}")
            await asyncio.sleep(0.01)
        raise TimeoutError(f"Scope activation timed out: {unit}")

    async def inspect(self, unit: str) -> dict:
        try:
            path = (await self.call("GetUnit", "s", [unit]))[0]
        except ManagerError as error:
            if "NoSuchUnit" in str(error):
                return {"LoadState": "not-found"}
            raise
        result = {}
        names = {
            "LoadState",
            "ActiveState",
            "SubState",
            "Result",
            "ControlGroup",
            "RuntimeMaxUSec",
            "TimeoutStopUSec",
            "ActiveEnterTimestampMonotonic",
            "CPUUsageNSec",
            "MemoryPeak",
            "MemoryCurrent",
            "TasksCurrent",
            "MemoryMax",
            "MemorySwapMax",
            "OOMPolicy",
            "CPUQuotaPerSecUSec",
            "Delegate",
            "MemoryOOMGroup",
        }
        for interface in ("org.freedesktop.systemd1.Unit", "org.freedesktop.systemd1.Scope"):
            values = (
                await self.call("GetAll", "s", [interface], path=path, interface="org.freedesktop.DBus.Properties")
            )[0]
            result.update({key: value.value for key, value in values.items() if key in names})
        return result

    async def stop(self, unit: str, timeout: float = 5) -> dict:
        try:
            await self.call("StopUnit", "ss", [unit, "replace"])
        except ManagerError as error:
            if "NoSuchUnit" not in str(error):
                raise
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            state = await self.inspect(unit)
            if state.get("ActiveState") not in ("active", "activating", "deactivating"):
                return state
            await asyncio.sleep(0.01)
        raise TimeoutError(f"Scope did not stop: {unit}")

    async def reset_failed(self, unit: str) -> None:
        try:
            await self.call("ResetFailedUnit", "s", [unit])
        except ManagerError as error:
            if "NoSuchUnit" not in str(error):
                raise

    async def release(self, unit: str) -> None:
        if unit in self.references:
            try:
                await self.call("UnrefUnit", "s", [unit])
            except ManagerError as error:
                if "NoSuchUnit" not in str(error):
                    raise
            finally:
                self.references.discard(unit)

    async def close(self) -> None:
        if self.bus is not None:
            bus, self.bus = self.bus, None
            try:
                await self._dispose(bus)
            finally:
                self.references.clear()

    @staticmethod
    async def _dispose(bus: MessageBus) -> None:
        # dbus-next 0.2.x disconnect() shuts down but does not close either
        # makefile or socket. Finalize also handles cancelled authentication,
        # before its normal message-reader callback has been installed.
        try:
            bus.disconnect()
            bus._finalize(None)
            await bus.wait_for_disconnect()
        finally:
            bus._stream.close()
            bus._sock.close()
