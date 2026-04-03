# Soulseek Featured MCP

Public MCP server for Soulseek search, browsing, downloads, rooms, and chat state.

## Exposed tools

- `search_files`
- `browse_user_shares`
- `browse_user_folder`
- `queue_download`
- `list_downloads`
- `list_saved_files`
- `read_saved_file_info`
- `delete_saved_file`
- `get_download_file_url`
- `list_rooms`
- `join_room`
- `leave_room`
- `say_room`
- `list_joined_rooms`
- `list_room_messages`
- `send_private_message`
- `list_private_chats`
- `list_private_messages`
- `watch_user`
- `get_auto_join_rooms`
- `set_auto_join_rooms`
- `reconnect_soulseek`
- `server_health`

## Auth

HTTP transport expects:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

The interactive docs page does not embed the token; it asks for it client-side in the browser.

Default deploy path:

- MCP endpoint: `/mcp`
- Health endpoint: `/health`
- Docs endpoint: `/docs`
- Files endpoint: `/files/:path`

## Required env

- `MCP_AUTH_TOKEN`
- `SLSK_USER`
- `SLSK_PASS`

## Local run

For a local host run, override the container-only paths from `.env.deploy`:

```bash
set -a && . ./.env.deploy && set +a
DOWNLOAD_DIR="$(pwd)/downloads" \
AUTO_JOIN_ROOMS_FILE="$(pwd)/data/auto-join-rooms.json" \
node server.js
```
