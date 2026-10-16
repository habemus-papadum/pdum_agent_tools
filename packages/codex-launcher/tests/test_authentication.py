import sys
import tomllib
from dataclasses import replace

import pytest
from pdum.codex_launcher.authentication import AuthSpec, apply_auth, auth_handled_paths, inspect_auth
from pdum.codex_launcher.errors import ProfileError
from pdum.codex_launcher.federation import FederationSpec

LAUNCHER = 'schema_version = 1\n[executable]\npath = "/example/codex"\n[environment]\ninherit_keys = ["MANUAL_KEY"]\n'
NATIVE = '# unchanged comment\nmodel = "gpt-6-luna"\n[future]\nsetting = "keep"\n'


def test_preserve_is_byte_for_byte_and_configuration_does_not_read_auth(tmp_path):
    assert apply_auth(NATIVE, LAUNCHER, AuthSpec(), tmp_path) == (NATIVE, LAUNCHER)
    (tmp_path / "auth.json").write_text("this is deliberately not valid JSON")
    inspection = inspect_auth(NATIVE, LAUNCHER, tmp_path)
    assert inspection.spec.method == "chatgpt"
    assert inspection.warnings


def test_api_key_and_chatgpt_switch_preserves_unrelated_native_and_environment(tmp_path):
    native, launcher = apply_auth(NATIVE, LAUNCHER, AuthSpec("api-key", "EXAMPLE_KEY"), tmp_path)
    settings = tomllib.loads(native)
    assert "# unchanged comment" in native
    assert settings["future"]["setting"] == "keep"
    provider = settings["model_providers"][settings["model_provider"]]
    assert provider["supports_websockets"] is True
    assert provider["requires_openai_auth"] is False
    assert provider["env_key"] == "EXAMPLE_KEY"
    assert inspect_auth(native, launcher, tmp_path).spec.method == "api-key"
    assert "EXAMPLE_KEY" in tomllib.loads(launcher)["environment"]["inherit_keys"]
    native, launcher = apply_auth(native, launcher, AuthSpec("chatgpt"), tmp_path)
    assert tomllib.loads(native)["model_provider"] == "openai"
    assert tomllib.loads(launcher)["environment"]["inherit_keys"] == ["MANUAL_KEY"]


def test_existing_manual_env_reference_is_not_removed_on_switch(tmp_path):
    native, launcher = apply_auth(NATIVE, LAUNCHER, AuthSpec("api-key", "MANUAL_KEY"), tmp_path)
    native, launcher = apply_auth(native, launcher, AuthSpec("chatgpt"), tmp_path)
    assert tomllib.loads(launcher)["environment"]["inherit_keys"] == ["MANUAL_KEY"]


def test_provider_name_collision_does_not_overwrite_user_provider(tmp_path):
    original = NATIVE + '\n[model_providers.pdum_api]\nname = "mine"\nfuture = "retain"\n'
    native, launcher = apply_auth(original, LAUNCHER, AuthSpec("api-key"), tmp_path)
    settings = tomllib.loads(native)
    assert settings["model_provider"] == "pdum_api_2"
    assert settings["model_providers"]["pdum_api"]["future"] == "retain"
    native, _ = apply_auth(native, launcher, AuthSpec("chatgpt"), tmp_path)
    assert tomllib.loads(native)["model_providers"]["pdum_api"]["future"] == "retain"


def test_federation_native_config_is_refreshable_and_inspected_native_first(tmp_path):
    federation = FederationSpec("us-east-1", "idp_example", "user-example", aws_home=tmp_path / "aws")
    native, launcher = apply_auth(NATIVE, LAUNCHER, AuthSpec("aws-federation", federation=federation), tmp_path)
    settings = tomllib.loads(native)
    provider = settings["model_providers"][settings["model_provider"]]
    assert provider["auth"]["command"] == sys.executable
    assert provider["auth"]["refresh_interval_ms"] == 240_000
    assert provider["auth"]["timeout_ms"] == 65_000
    assert provider["supports_websockets"] is True
    assert "env_key" not in provider
    inspection = inspect_auth(native, launcher, tmp_path)
    assert inspection.spec.federation == federation
    assert inspect_auth(native, launcher, tmp_path / "copied").spec.method == "preserve"
    changed = native.replace('model_provider = "pdum_aws_federation"', 'model_provider = "custom"')
    assert inspect_auth(changed, launcher, tmp_path).spec.method == "preserve"
    native, launcher = apply_auth(native, launcher, AuthSpec("api-key", "NEW_KEY"), tmp_path)
    provider = tomllib.loads(native)["model_providers"]["pdum_aws_federation"]
    assert "auth" not in provider
    assert provider["env_key"] == "NEW_KEY"
    assert "federation" not in tomllib.loads(launcher)["authentication"]


def test_unrecognized_native_helper_is_preserved_even_if_metadata_claims_managed(tmp_path):
    federation = FederationSpec("us-east-1", "idp_example", "user-example")
    native, launcher = apply_auth(NATIVE, LAUNCHER, AuthSpec("aws-federation", federation=federation), tmp_path)
    native = native.replace("pdum.codex_launcher._federation_helper", "some_other_helper")
    assert inspect_auth(native, launcher, tmp_path).spec.method == "preserve"


@pytest.mark.parametrize(
    "spec", [AuthSpec("invalid"), AuthSpec("api-key", "not a variable"), AuthSpec("aws-federation")]
)
def test_auth_rejects_incomplete_explicit_settings(tmp_path, spec):
    with pytest.raises(ProfileError):
        apply_auth(NATIVE, LAUNCHER, spec, tmp_path)


def test_invalid_federation_setting_rejected_before_returning_config(tmp_path):
    federation = FederationSpec("us-east-1", "idp_example", "user-example")
    for invalid in (replace(federation, refresh_interval_seconds=0), replace(federation, aws_home="relative")):
        with pytest.raises(ProfileError):
            apply_auth(NATIVE, LAUNCHER, AuthSpec("aws-federation", federation=invalid), tmp_path)


def test_chatgpt_rejects_custom_builtin_provider_override(tmp_path):
    native = NATIVE + '\n[model_providers.openai]\nname = "custom"\nenv_key = "CUSTOM_TOKEN"\n'
    with pytest.raises(ProfileError, match="custom.*model_providers.openai"):
        apply_auth(native, LAUNCHER, AuthSpec("chatgpt"), tmp_path)


def test_chatgpt_reserves_absent_builtin_provider_override_in_remaining_editor():
    assert ("model_providers", "openai") in auth_handled_paths(NATIVE, LAUNCHER, AuthSpec("chatgpt"))


def test_explicit_auth_clears_named_profile_selector_but_preserves_table(tmp_path):
    native = 'profile = "named"\n' + NATIVE + '\n[profiles.named]\nmodel_provider = "other"\n'
    assert inspect_auth(native, LAUNCHER, tmp_path).spec.method == "preserve"
    changed, _ = apply_auth(native, LAUNCHER, AuthSpec("api-key"), tmp_path)
    parsed = tomllib.loads(changed)
    assert "profile" not in parsed
    assert parsed["profiles"]["named"]["model_provider"] == "other"
    assert ("profile",) in auth_handled_paths(native, LAUNCHER, AuthSpec("api-key"))
    assert auth_handled_paths(native, LAUNCHER, AuthSpec()) == ()


def test_reconfiguring_managed_provider_preserves_unrecognized_provider_fields(tmp_path):
    native, launcher = apply_auth(NATIVE, LAUNCHER, AuthSpec("api-key"), tmp_path)
    native += '\n[model_providers.pdum_api.future]\nsetting = "keep"\n'
    native, launcher = apply_auth(native, launcher, AuthSpec("api-key", "SECOND_KEY"), tmp_path)
    parsed = tomllib.loads(native)
    assert parsed["model_providers"]["pdum_api"]["future"]["setting"] == "keep"
    assert tomllib.loads(launcher)["environment"]["inherit_keys"] == ["MANUAL_KEY", "SECOND_KEY"]
    assert ("model_providers", "pdum_api") in auth_handled_paths(native, launcher, AuthSpec("api-key"))


@pytest.mark.parametrize("base_url", ["", 'base_url = "https://api.example.invalid/v1"\n'])
@pytest.mark.parametrize("method", ["chatgpt", "api-key", "aws-federation"])
def test_old_generated_api_profile_migrates_only_its_required_environment_key(tmp_path, base_url, method):
    native = (
        'model_provider = "pdum_api"\n'
        "[model_providers.pdum_api]\n"
        'name = "Profile API key"\n'
        'env_key = "LEGACY_KEY"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = false\n" + base_url
    )
    launcher = LAUNCHER.replace('["MANUAL_KEY"]', '["MANUAL_KEY", "LEGACY_KEY"]')
    spec = AuthSpec(
        method,
        api_key_env="NEW_KEY",
        federation=FederationSpec("us-east-1", "idp_example", "user-example") if method == "aws-federation" else None,
    )
    assert ("model_providers", "pdum_api") in auth_handled_paths(native, launcher, spec)
    updated_native, updated_launcher = apply_auth(native, launcher, spec, tmp_path)
    inherited = tomllib.loads(updated_launcher)["environment"]["inherit_keys"]
    assert inherited == (["MANUAL_KEY", "NEW_KEY"] if method == "api-key" else ["MANUAL_KEY"])
    if method == "chatgpt":
        assert "pdum_api" not in tomllib.loads(updated_native).get("model_providers", {})


@pytest.mark.parametrize(
    "extra", ['future_setting = "mine"\n', "supports_websockets = true\n", 'experimental_bearer_token = "fixture"\n']
)
def test_legacy_migration_does_not_claim_customized_provider(tmp_path, extra):
    native = (
        'model_provider = "pdum_api"\n'
        "[model_providers.pdum_api]\n"
        'name = "Profile API key"\n'
        'env_key = "MANUAL_KEY"\n'
        'wire_api = "responses"\n'
        "requires_openai_auth = false\n" + extra
    )
    changed_native, changed_launcher = apply_auth(native, LAUNCHER, AuthSpec("chatgpt"), tmp_path)
    assert tomllib.loads(changed_native)["model_providers"]["pdum_api"]["env_key"] == "MANUAL_KEY"
    assert tomllib.loads(changed_launcher)["environment"]["inherit_keys"] == ["MANUAL_KEY"]
