# perplexapi

To install dependencies:

```bash
bun install
```

To run:

```bash
PPLX_COOKIE='your_perplexity_cookie' bun run start
```

OpenAI-compatible endpoint:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "perplexity-online",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

Vercel proxy:

Set these environment variables in Vercel:

```bash
KEY='client_api_key'
PPLX_COOKIE='your_perplexity_cookie'
```

Then call Vercel directly with the same OpenAI-compatible interface. Vercel checks
`KEY`, then calls Perplexity:

```bash
curl https://your-vercel-app.vercel.app/v1/chat/completions \
  -H 'Authorization: Bearer client_api_key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "perplexity-online",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

The explicit Vercel API path also works:

```bash
curl https://your-vercel-app.vercel.app/api/v1/chat/completions \
  -H 'Authorization: Bearer client_api_key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "perplexity-online",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
