# dsh-plugin

Personal [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin collection.

Each subdirectory is one installable bundle. Bundles are plain ESM packages with a
`cordis.patch.yml`; no build step and no dependencies are required.

## Plugins

| Plugin | Description |
| --- | --- |
| [`deepseek-balance-peak`](deepseek-balance-peak/README.md) | Card above the sidebar account row: DeepSeek balance, this Session's spend (priced per request at the moment the request started), and the peak/off-peak price countdown. |

## Install

Install a bundle directory into the current Harness profile with Plugin Manager's
`install_bundle` action, passing the absolute package path, for example:

```
/Users/<you>/Workspace/dsh-plugin/deepseek-balance-peak
```

That symlinks the package into the profile, applies its patch, and activates it.
Reload the Harness page (Ctrl/Cmd+Shift+R) after installing so the Web client loads
the new client module.

## Adding a plugin

1. Create `dsh-plugin/<plugin-name>/` with `package.json` (`dsh.bundle.patch`, and
   `dsh.client` for a Web UI half), `cordis.patch.yml`, `index.js`, optionally
   `client.js`, `locale/*.json`, and `icon.svg`.
2. Keep the runtime `exports` and `files` lists accurate.
3. Install it with `install_bundle` and add a row to the table above.
