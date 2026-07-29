# Privacy Policy — CREV Inspector

Last updated: 29 July 2026

CREV Inspector is an independent developer tool by Tassilo Heinemann for inspecting and editing user-chosen Corporater BMP workspaces. It has no analytics, advertising, user accounts, or developer-operated data service.

## Data handled

The extension stores its settings, server profiles, favourites, caches, activity history, and optional credentials locally in Chrome or Edge storage. It accesses configuration data, code, object metadata, and the active BMP session only for features the user invokes.

Borrowed BMP tokens are kept in browser session storage and disappear when the browser closes. Optional saved BMP passwords and AI API keys are stored locally using AES-GCM. This protects against casual inspection of browser storage, not compromise of the device or browser profile.

If the user configures the optional AI assistant, the API key, messages, and attached BMP or code context are sent directly from the browser to the provider selected by the user. They are not routed through or accessible to the developer. The selected provider processes that data under its own terms and privacy policy.

The extension checks GitHub Releases for newer versions. That request includes the normal network information received by GitHub, but no BMP content, credentials, or AI messages.

## Sharing and use

The developer does not receive, sell, or use extension data. Data is sent only to the BMP server chosen by the user, an AI provider explicitly configured by the user, or GitHub for the update check. The extension uses data only to provide its user-requested inspection, editing, connection, and AI features.

CREV Inspector's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## User control

Users can delete individual server profiles, remove the AI configuration, clear local working data, or uninstall the extension. “Reset all” clears caches, activity, history, and current context but deliberately keeps server profiles and favourites; those can be deleted separately.

Site access is requested through the browser for configured BMP and AI origins and can be revoked in the browser’s extension settings.

## Contact

Questions can be submitted through the [CREV Inspector GitHub repository](https://github.com/HeinemannT/crev-inspector/issues).
