"""Process entry point for Codex's native command-backed bearer provider."""

from .federation import app

if __name__ == "__main__":
    app()
