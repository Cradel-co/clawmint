'use strict';

const {
  parseDuration,
  formatRemaining,
  add,
  remove,
  listForChat,
  popTriggered,
} = require('../reminders');

// ── parseDuration ─────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test.each([
    ['30s',    30_000],
    ['5seg',   5_000],
    ['10m',    600_000],
    ['10min',  600_000],
    ['2h',     7_200_000],
    ['2hs',    7_200_000],
    ['1d',     86_400_000],
    ['2dias',  2 * 86_400_000],
    ['1h30m',  5_400_000],
    ['2h45m',  (2 * 3600 + 45 * 60) * 1000],
  ])('%s → %i ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  test('string sin unidad → null', () => {
    expect(parseDuration('ahora')).toBeNull();
  });

  test('string vacío → null', () => {
    expect(parseDuration('')).toBeNull();
  });

  test('número sin unidad → null', () => {
    expect(parseDuration('42')).toBeNull();
  });
});

// ── formatRemaining ───────────────────────────────────────────────────────────

describe('formatRemaining', () => {
  test('negativo → "vencido"', () => {
    expect(formatRemaining(-1)).toBe('vencido');
  });

  test('0 ms → "0s"', () => {
    expect(formatRemaining(0)).toBe('0s');
  });

  test('45 000 ms → "45s"', () => {
    expect(formatRemaining(45_000)).toBe('45s');
  });

  test('3 minutos exactos → "3m"', () => {
    expect(formatRemaining(3 * 60_000)).toBe('3m');
  });

  test('2 horas exactas → "2h"', () => {
    expect(formatRemaining(2 * 3_600_000)).toBe('2h');
  });

  test('2h 30m → "2h 30m"', () => {
    expect(formatRemaining(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m');
  });

  test('1 día exacto → "1d"', () => {
    expect(formatRemaining(86_400_000)).toBe('1d');
  });

  test('1d 6h → "1d 6h"', () => {
    expect(formatRemaining(86_400_000 + 6 * 3_600_000)).toBe('1d 6h');
  });
});

// ── Funciones con estado ──────────────────────────────────────────────────────

describe('reminders stateful', () => {
  // chatId único para no interferir con estado de otros tests
  const CHAT  = 999_888_777;
  const BOT   = '__test-bot__';

  // Limpieza: eliminar cualquier recordatorio del chat de test
  afterEach(() => {
    listForChat(CHAT).forEach(r => remove(r.id));
  });

  test('add() crea recordatorio; listForChat() lo incluye', () => {
    const r = add(CHAT, BOT, 'recordar esto', 60_000);
    expect(r.id).toBeTruthy();
    expect(r.chatId).toBe(CHAT);
    expect(r.text).toBe('recordar esto');
    const lista = listForChat(CHAT);
    expect(lista.some(x => x.id === r.id)).toBe(true);
  });

  test('remove() elimina el recordatorio', () => {
    const r = add(CHAT, BOT, 'para borrar', 60_000);
    const ok = remove(r.id);
    expect(ok).toBe(true);
    expect(listForChat(CHAT).some(x => x.id === r.id)).toBe(false);
  });

  test('remove() con id inexistente retorna false', () => {
    expect(remove('id-que-no-existe-nunca')).toBe(false);
  });

  test('listForChat() no devuelve recordatorios de otros chats', () => {
    const OTHER = 111_222_333;
    const r = add(OTHER, BOT, 'otro chat', 60_000);
    expect(listForChat(CHAT).some(x => x.id === r.id)).toBe(false);
    remove(r.id);
  });

  test('popTriggered() retorna y elimina recordatorios vencidos', async () => {
    const r = add(CHAT, BOT, 'ya vencido', 1);  // vence en 1ms
    await new Promise(resolve => setTimeout(resolve, 10));
    const triggered = popTriggered();
    expect(triggered.some(x => x.id === r.id)).toBe(true);
    // Ya no debe estar en la lista
    expect(listForChat(CHAT).some(x => x.id === r.id)).toBe(false);
  });

  test('popTriggered() no devuelve recordatorios aún vigentes', () => {
    const r = add(CHAT, BOT, 'en el futuro', 60_000);
    const triggered = popTriggered();
    expect(triggered.some(x => x.id === r.id)).toBe(false);
  });

  test('add() asigna triggerAt = now + durationMs', () => {
    const before = Date.now();
    const r = add(CHAT, BOT, 'timing', 5_000);
    const after = Date.now();
    expect(r.triggerAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(r.triggerAt).toBeLessThanOrEqual(after + 5_000);
  });
});
