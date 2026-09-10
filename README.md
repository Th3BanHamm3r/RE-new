# RE:new for Firefox

RE:new is a Firefox extension that adds bulk selection and relisting controls back to the Facebook Marketplace `Selling` page; since Meta is incompetent.

> **Important:** RE:new is an independent project and is not affiliated with, endorsed by, or supported by Meta or Facebook. It relies on Facebook Marketplace page structure and internal request formats, which can change without notice.

## Features

- Individual listing selectors over listing image.
- Listing-age badges displayed over listing image.
- **Select all** and **Deselect all** controls.
- **Select listings older than** control with adjustable age threshold.
- Existing listing prices are preserved during relisting.
- Attempts to preserve listing details, photos, videos, shipping configuration, and other Marketplace attributes.
- Relist progress displayed directly above the control panel.
- Light and dark UI themes designed to follow Facebook Marketplace settings.

## Using RE:new

1. Install or load RE:new in Firefox.
2. Sign in to Facebook normally.
3. Open Facebook Marketplace.
4. Navigate to **Your listings / Selling** page.
5. Wait for RE:new to scan the active listings.
6. Select listings using one of the available methods:
   - Click the selector on an individual listing.
   - Click **Select all**.
   - Set an age threshold under **SELECT LISTINGS OLDER THAN** and click **Select**.
7. Click **Relist Selected**.
8. Keep the Marketplace tab open while the operation is running.

Because RE:new depends on Facebook's internal Marketplace behavior, test a new release with a single listing before processing a large batch.

## Firefox Installation

RE:new is distributed directly from this repository as a Mozilla-signed Firefox `.xpi` package rather than through the Firefox Add-ons store.

Release builds are stored in:

```text
dist/
```

For example:

```text
dist/REnew-firefox-v1.0.0.xpi
```

### Install a Release Build

1. Download the latest `.xpi` file from the repository's `dist/` directory.
2. Open Firefox and navigate to:

```text
about:addons
```

3. Click the gear icon in the Add-ons Manager.
4. Select **Install Add-on From File…**
5. Select the downloaded RE:new `.xpi` file.
6. Confirm the installation when Firefox prompts you.
7. Open or refresh the Facebook Marketplace **Selling** page.

The release `.xpi` is signed by Mozilla for unlisted distribution, so it can be installed persistently in a normal Firefox release without publishing RE:new in the Firefox Add-ons store.

Installed release builds remain installed after Firefox is restarted.

## Permissions

RE:new requests the following Firefox extension permissions:

```text
tabs
scripting
storage
```

Runtime host access is limited to:

```text
https://*.facebook.com/*
https://*.fbcdn.net/*
```

These permissions allow the extension to interact with Facebook Marketplace, preserve listing information during the refresh process, maintain local extension state, and work with Facebook-hosted media.

## Privacy

RE:new does not send usage data to analytics services, telemetry collectors, Sentry, or other third-party reporting systems.

The extension communicates with Facebook and Facebook CDN hosts as required for Marketplace operations.

RE:new uses Firefox extension storage for local operational data such as:

- Marketplace listing cache.
- Facebook session-related cache data.
- GraphQL document-ID cache.
- Recently refreshed listing identifiers.
- Extension state used by the UI.

Diagnostic messages may be written to the browser developer console for troubleshooting. RE:new does not transmit those console messages to an external logging service.

## Compatibility

RE:new currently targets Firefox Manifest V3 and requires:

```text
Firefox 128 or newer
```

Facebook does not provide a stable public API for the relisting workflow used by this extension. Marketplace markup, GraphQL document IDs, media upload behavior, and request structures can change independently of RE:new.

## License

RE:new is licensed under the [Mozilla Public License 2.0](LICENSE).

See `LICENSE` for the complete license text.
