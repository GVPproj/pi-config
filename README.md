# pi-config

A standalone [Pi](https://github.com/earendil-works/pi) package providing a custom startup screen, themes, Pi-only subagents, and parent-owned background terminals. It targets Pi 0.84.2.

## Resources

- `extensions/startup-screen`: responsive welcome card with the active model, tips, tool count, and recent sessions
- `themes`: Solarized Osaka theme
- `extensions/background-terminals`: bounded, inspectable background processes
- `extensions/subagents`: in-process Pi child agents
- `skills/background-terminals`: guidance for background-process tools
- `skills/subagents`: guidance for delegating work to child agents

## Development

```bash
npm install
npm run format:check
npm run check
npm test
```

## Attribution

Credit to [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup), revision [`73bf4d8`](https://github.com/davis7dotsh/my-pi-setup/commit/73bf4d826f39b5cab6b7865e706ba4a2669629ca), by Benjamin Davis. Forking from there to do my own thing.
