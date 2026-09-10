# Development

### Requirements

- GNU Make or compatible `make`
- Git
- Debian/Ubuntu or WSL with Ubuntu is recommended for the automated setup

`make install-dev` verifies or installs the remaining development tooling. The automated Node.js and `pipx` installation paths currently target Debian/Ubuntu systems.

### Install Development Tools

Run:

```shell
make install-dev
```

This will:

- Verify or install Node.js 22.
- Install the locked npm development dependencies with `npm ci`.
- Install Mozilla `web-ext` 10.6.0 under `~/.local/bin` when necessary.
- Install `prek` 0.5.2 from PyPI through `pipx` when necessary.
- Create a private `.env` file from `.env.example` if one does not already exist.
- Configure the repository Git hook through `prek` when run inside a Git repository.

The project uses `prek` to coordinate code-quality hooks. Mozilla `web-ext` is used to sign an unlisted Firefox XPI for self-distribution.

### Development Installation

When developing RE:new from source, it can also be loaded as a temporary extension without creating a signed `.xpi`.

1. Clone or extract the RE:new repository.
2. Open:

```text
about:debugging#/runtime/this-firefox
```

3. Click **Load Temporary Add-on…**
4. Select:

```text
manifest.json
```

5. Open or refresh the Facebook Marketplace **Selling** page.

Temporary add-ons are removed when Firefox exits.

Do not move, rename, or delete the repository directory while Firefox has the temporary extension loaded.

### Reloading During Development

After editing JavaScript, CSS, assets, or the manifest:

1. Save the files.
2. Open:

```text
about:debugging#/runtime/this-firefox
```

3. Find **RE:new**.
4. Click **Reload**.
5. Return to Facebook.
6. Refresh the Marketplace tab.

For release builds, increment the version in `manifest.json` and create a new signed package with:

```shell
make package
```

The resulting signed `.xpi` is written to:

```text
dist/REnew-firefox-v<version>.xpi
```

Release `.xpi` files are included in the repository's `dist/` directory.

## Development Checks

Run the complete verification suite with:

```shell
make check
```

Run only formatting and lint hooks with:

```shell
make lint
```

Run only static analysis with:

```shell
make static
```

### Code-Quality Checks

The `prek` configuration runs:

- `ESLint` for JavaScript.
- `Prettier` for Markdown and CSS.
- `codespell` for spelling checks.

Some lint hooks automatically modify files. If this occurs, restage changes before committing.

## CI/CD Pipeline

GitHub Actions runs verification on pushes and pull requests.

The CI workflow:

1. Checks out the repository.
2. Sets up Node.js 22.
3. Runs `npm ci` using `package-lock.json`.
4. Installs `prek` 0.5.2 with the CI installer.
5. Runs `prek run --all-files`.
6. Runs static analysis.

Workflow configuration:

```text
.github/workflows/ci.yml
```

The signing credentials in `.env` are local development secrets and are not required by the verification-only CI workflow.

## Mozilla Signing Credentials

`make install-dev` creates `.env` when it is missing. Populate it with the Mozilla Add-ons API credentials used by `web-ext sign`:

```dotenv
WEB_EXT_API_KEY=user:12345:67
WEB_EXT_API_SECRET=your-jwt-secret
```

Create the credentials from the Mozilla Add-ons developer API credentials page:

<https://addons.mozilla.org/developers/addon/api/key/>

The `.env` file is ignored by Git and should never be committed, copied into release artifacts, or shared. `.env.example` is the tracked template and contains no credentials.

`web-ext` recognizes these environment variable names directly:

- `WEB_EXT_API_KEY` — Mozilla Add-ons JWT issuer/API key.
- `WEB_EXT_API_SECRET` — Mozilla Add-ons JWT secret.

## Packaging

Create a Mozilla-signed, unlisted Firefox XPI with:

```shell
make package
```

All checks must pass before packaging begins.

The package target:

1. Loads `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` from `.env`.
2. Stages only the Firefox runtime files under `dist/extension/`.
3. Runs `web-ext lint` against the staged extension.
4. Runs `web-ext sign --channel=unlisted` against the staged extension.
5. Downloads the Mozilla-signed XPI.
6. Renames the result using the version from `manifest.json`.
7. Removes the temporary staging and signing directories.

The output is written to:

```text
dist/REnew-firefox-v<version>.xpi
```

For version `1.0.0`, the resulting file is:

```text
dist/REnew-firefox-v1.0.0.xpi
```

The signed runtime package contains only the files required by Firefox:

```text
manifest.json
background.js
contentScript.js
assets/
icon16.png
icon48.png
icon128.png
```

Development tooling, Git metadata, `.env`, source-only files, and temporary build output are not included in the XPI.

Mozilla documents `web-ext sign --channel=unlisted` as the signing flow for self-distributed extensions. The command submits the extension to Mozilla for signing and downloads a signed `.xpi` that can be installed in standard Firefox. The `Waiting for approval...` step can take some time.

## Repository Layout

```text
.
├── .githooks/
│   └── pre-commit
├── .github/
│   └── workflows/
│       └── ci.yml
├── assets/
│   ├── brand-glyph.png
│   └── overlay.css
├── scripts/
│   ├── lint.mjs
│   └── validate.mjs
├── types/
│   └── webextension-globals.d.ts
├── .env.example
├── .gitattributes
├── .gitignore
├── background.js
├── contentScript.js
├── DEVELOPMENT.md
├── eslint.config.mjs
├── icon16.png
├── icon48.png
├── icon128.png
├── LICENSE
├── Makefile
├── manifest.json
├── package-lock.json
├── package.json
├── prek.toml
├── README.md
├── tsconfig.json
└── UI.png
```

The local `.env` file is intentionally omitted from the repository layout because it is ignored by Git and contains signing credentials.
