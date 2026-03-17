#!/bin/sh
set -e

# Crear directorios de datos si no existen
mkdir -p /app/server/memory
mkdir -p /app/server/skills

exec "$@"
