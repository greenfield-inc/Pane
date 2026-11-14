// The C ABI of the pane-direct Rust library (direct/src/ffi.rs).
#pragma once
#include <stdint.h>

/// Starts a connection. Returns {"id","port"} or {"error"} as JSON; free it with pane_direct_free_string.
char *pane_direct_connect(const char *config_json);
/// The next event as JSON, NULL on timeout, {"t":"closed"} once closed.
char *pane_direct_next_event(uint64_t id, uint32_t timeout_ms);
void pane_direct_close(uint64_t id);
void pane_direct_free_string(char *text);
