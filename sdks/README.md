# Zelavis SDK Codegen

Tooling for extracting the OpenAPI spec and generating multi-language SDK clients.

## Usage

### Extract OpenAPI Spec

```bash
# From a running Zelavis instance
curl http://localhost:4321/zelavis/api/v1/runtime/openapi.json > sdks/openapi/zelavis-api.json
```

### Generate SDKs

Once the OpenAPI spec is extracted, use [OpenAPI Generator](https://openapi-generator.tech/)
with the per-language configs in `codegen/openapi-config/`:

```bash
openapi-generator-cli generate \
  -i sdks/openapi/zelavis-api.json \
  -c sdks/codegen/openapi-config/python.yaml \
  -o sdks/python
```

## Directory Structure

```
sdks/
├── openapi/              # Generated OpenAPI spec
│   └── zelavis-api.json  # Auto-generated, do not edit
├── codegen/              # Codegen orchestrator
│   └── openapi-config/   # Per-language OpenAPI Generator configs
├── python/               # Python SDK
├── java/                 # Java SDK
├── csharp/               # C# SDK
└── rust/                 # Rust SDK
```

## Adding a New Language

1. Add an OpenAPI Generator config to `codegen/openapi-config/<lang>.yaml`
2. Run `openapi-generator-cli generate` with the new config
3. Hand-polish with Zelavis-specific ergonomics (tenant handles, error types)
