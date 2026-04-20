'use strict';

/**
 * user-sandbox.js — Helpers para aislamiento de carpetas por usuario.
 *
 * Cada usuario (role='user') opera dentro de server/user-data/<userId>/.
 * Admins (role='admin') no tienen restricción.
 */

const path = require('path');
const fs   = require('fs');

const USER_DATA_ROOT = path.join(__dirname, '..', '..', 'user-data');

/**
 * Retorna la raíz de la carpeta del usuario, creándola si no existe.
 */
function getUserRoot(userId) {
  if (!userId) return null;
  const userDir = path.join(USER_DATA_ROOT, userId);
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}

/**
 * Resuelve el userId desde el contexto (igual que scheduled.js).
 */
function resolveUserId(ctx) {
  if (ctx.userId) return ctx.userId;
  const chatId  = ctx.chatId;
  const channel = ctx.channel || 'telegram';
  if (ctx.usersRepo && chatId) {
    const user = ctx.usersRepo.findByIdentity(channel, String(chatId));
    if (user) return user.id;
  }
  return null;
}

/**
 * Verifica si el usuario del contexto es admin.
 */
function isAdmin(ctx) {
  const userId = resolveUserId(ctx);
  if (!userId || !ctx.usersRepo) return false;
  const user = ctx.usersRepo.getById(userId);
  return user && user.role === 'admin';
}

/**
 * Verifica que un path resuelto esté dentro de la carpeta del usuario.
 * Admins pueden acceder a cualquier ruta.
 * Lanza error si el acceso no está permitido.
 */
function assertPathAllowed(resolvedPath, ctx) {
  if (isAdmin(ctx)) return;
  const userId = resolveUserId(ctx);
  if (!userId) throw new Error('No se pudo identificar al usuario. Acceso denegado.');
  const userRoot = getUserRoot(userId);
  const normalized = path.resolve(resolvedPath);
  if (!normalized.startsWith(userRoot)) {
    throw new Error(`Acceso denegado: solo podés operar dentro de tu carpeta personal.`);
  }
}

/**
 * Retorna el directorio base para operaciones de archivo.
 * Admins: HOME. Usuarios normales: su carpeta aislada.
 */
function getBaseDir(ctx) {
  if (isAdmin(ctx)) return process.env.HOME || '/';
  const userId = resolveUserId(ctx);
  if (!userId) return null;
  return getUserRoot(userId);
}

module.exports = { USER_DATA_ROOT, getUserRoot, resolveUserId, isAdmin, assertPathAllowed, getBaseDir };
