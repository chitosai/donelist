# Done List project instructions

## Local development origin

- Always start the development server at `http://127.0.0.1:5173/`.
- Do not substitute `localhost`, another hostname, or another port unless the user explicitly requests it.
- IndexedDB data is scoped to the complete origin (scheme, hostname, and port). Changing any part of the origin makes the existing records appear unavailable.
- Preferred command: `pnpm dev --host 127.0.0.1 --port 5173`.
