"""Scoped environment configuration without system proxy or trust mutation."""

import hashlib
import os
import ssl
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import certifi

TrustAdapter = Literal["node", "openssl", "requests", "all"]


@dataclass(frozen=True)
class ProxyConnection:
    """Connection settings valid for the lifetime of a sidecar.

    Parameters
    ----------
    proxy_url
        Connectable regular HTTP proxy URL, including the allocated port.
    ca_cert_path
        Public run-local interception CA certificate.
    run_id
        Unique run identity, also used for the archive directory.
    """

    proxy_url: str
    ca_cert_path: Path
    run_id: str

    def environment(self, base: Mapping[str, str], *, trust: TrustAdapter = "openssl") -> dict[str, str]:
        """Return a new environment with explicit proxy and selected CA settings.

        Parameters
        ----------
        base
            Consumer's intended environment, copied without modifying it.
        trust
            Tested convention to configure. ``openssl`` includes Codex's Rust
            TLS client; ``node`` preserves Node's normal root store; ``requests``
            configures Requests. ``all`` combines these conventions.

        Returns
        -------
        dict[str, str]
            New environment. CA bundles preserve applicable existing roots.
        """
        if trust not in ("node", "openssl", "requests", "all"):
            raise ValueError(f"unsupported trust adapter: {trust}")
        environment = dict(base)
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            environment[name] = environment[name.lower()] = self.proxy_url
        existing_bypass = environment.get("NO_PROXY", environment.get("no_proxy", ""))
        bypass = list(dict.fromkeys(filter(None, (*existing_bypass.split(","), "localhost", "127.0.0.1", "::1"))))
        environment["NO_PROXY"] = environment["no_proxy"] = ",".join(bypass)
        if trust in ("node", "all"):
            previous = environment.get("NODE_EXTRA_CA_CERTS")
            environment["NODE_EXTRA_CA_CERTS"] = str(self._bundle([Path(previous)] if previous else []))
        if trust in ("openssl", "all"):
            previous = environment.get("SSL_CERT_FILE")
            default = ssl.get_default_verify_paths().cafile
            roots = [Path(previous)] if previous else [Path(default or certifi.where())]
            environment["SSL_CERT_FILE"] = str(self._bundle(roots))
        if trust in ("requests", "all"):
            previous = environment.get("REQUESTS_CA_BUNDLE") or environment.get("CURL_CA_BUNDLE")
            roots = [Path(previous or certifi.where())]
            environment["REQUESTS_CA_BUNDLE"] = str(self._bundle(roots))
        return environment

    def _bundle(self, roots: list[Path]) -> Path:
        content = b"\n".join([*(root.read_bytes() for root in roots), self.ca_cert_path.read_bytes()]) + b"\n"
        path = self.ca_cert_path.parent / f"trust-{hashlib.sha256(content).hexdigest()}.pem"
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return path
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        return path
