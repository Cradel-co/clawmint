#!/bin/bash
# Wrapper para invocar claude -p sin triggerear detección de sesión anidada
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT
exec claude "$@"
