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

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
