# ghlogo

A Cloudflare Worker that redirects to the `og:image` of any GitHub repository, organization, or user.

## Usage

```
https://ghlogo.heathdutton.workers.dev/{owner}
https://ghlogo.heathdutton.workers.dev/{owner}/{repo}
```

### Examples

| URL | Redirects to |
|-----|--------------|
| [/anthropics](https://ghlogo.heathdutton.workers.dev/anthropics) | Anthropic's org avatar |
| [/anthropics/claude-code](https://ghlogo.heathdutton.workers.dev/anthropics/claude-code) | claude-code repo's social preview |
| [/torvalds](https://ghlogo.heathdutton.workers.dev/torvalds) | Linus Torvalds' avatar |
| [/torvalds/linux](https://ghlogo.heathdutton.workers.dev/torvalds/linux) | Linux repo's social preview |

### In Markdown

```markdown
![Repo Logo](https://ghlogo.heathdutton.workers.dev/owner/repo)
```

### In HTML

```html
<img src="https://ghlogo.heathdutton.workers.dev/owner/repo" alt="Repo Logo">
```

## How It Works

1. Fetches the GitHub page for the given path
2. Extracts the `<meta property="og:image">` URL
3. Returns a 302 (temporary) redirect to that image - temporary because the og:image URL changes when owners update their social preview
4. Caches the redirect in memory for 1 hour

The in-memory cache persists for the lifetime of the worker isolate, reducing latency for repeated requests.

## Deploy Your Own

```bash
# Clone
git clone https://github.com/heathdutton/ghlogo.git
cd ghlogo

# Install
npm install

# Test locally
npm run dev

# Deploy (requires wrangler auth)
npm run deploy
```

Update the `name` in `wrangler.toml` to use your own subdomain.

## License

MIT
