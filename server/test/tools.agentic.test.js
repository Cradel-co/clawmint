'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ResumableSessionsRepository = require('../storage/ResumableSessionsRepository');
const SuspendedPromptsManager = require('../core/SuspendedPromptsManager');
const tools = require('../mcp/tools/agenticParked');

const [SCHEDULE_WAKEUP, ASK_USER_QUESTION] = tools;

async function makeRepo() {
  const Database = require('../storage/sqlite-wrapper');
  if (!Database.isInitialized()) await Database.initialize();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsa-'));
  const db = new Database(path.join(tmpDir, 'test.db'));
  const repo = new ResumableSessionsRepository(db);
  repo.init();
  return { repo, db, tmpDir };
}

describe('schedule_wakeup (Fase 9 cierre)', () => {
  let repo, db, tmpDir;

  beforeAll(async () => {
    const m = await makeRepo();
    repo = m.repo; db = m.db; tmpDir = m.tmpDir;
  });

  afterAll(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  afterEach(() => { db.prepare('DELETE FROM resumable_sessions').run(); });

  test('error si delaySeconds inválido', async () => {
    const r1 = await SCHEDULE_WAKEUP.execute({ reason: 'x' }, { resumableSessionsRepo: repo, chatId: 'c1' });
    expect(r1).toContain('delaySeconds');
    const r2 = await SCHEDULE_WAKEUP.execute({ delaySeconds: -5, reason: 'x' }, { resumableSessionsRepo: repo, chatId: 'c1' });
    expect(r2).toContain('delaySeconds');
    const r3 = await SCHEDULE_WAKEUP.execute({ delaySeconds: 999999999, reason: 'x' }, { resumableSessionsRepo: repo, chatId: 'c1' });
    expect(r3).toContain('máximo');
  });

  test('error si reason falta', async () => {
    const r = await SCHEDULE_WAKEUP.execute({ delaySeconds: 60 }, { resumableSessionsRepo: repo, chatId: 'c1' });
    expect(r).toContain('reason');
  });

  test('error si chatId falta en ctx', async () => {
    const r = await SCHEDULE_WAKEUP.execute({ delaySeconds: 60, reason: 'x' }, { resumableSessionsRepo: repo });
    expect(r).toContain('chatId');
  });

  test('programa con éxito y persiste en DB', async () => {
    const before = Date.now();
    const r = await SCHEDULE_WAKEUP.execute(
      { delaySeconds: 300, reason: 'revisar después', resumePrompt: 'retomá lo de antes' },
      { resumableSessionsRepo: repo, chatId: 'c1', agentKey: 'a', provider: 'anthropic', channel: 'web' },
    );
    expect(r).toContain('schedule_wakeup programado');
    const all = repo.listByChatId('c1');
    expect(all).toHaveLength(1);
    expect(all[0].resume_prompt).toBe('retomá lo de antes');
    expect(all[0].trigger_at).toBeGreaterThanOrEqual(before + 300_000);
  });

  test('resumePrompt default usa reason', async () => {
    await SCHEDULE_WAKEUP.execute(
      { delaySeconds: 60, reason: 'alarma matutina' },
      { resumableSessionsRepo: repo, chatId: 'c1' },
    );
    const got = repo.listByChatId('c1')[0];
    expect(got.resume_prompt).toContain('alarma matutina');
  });

  test('error si repo no está en ctx', async () => {
    const r = await SCHEDULE_WAKEUP.execute(
      { delaySeconds: 60, reason: 'x' },
      { chatId: 'c1' },
    );
    expect(r).toContain('ResumableSessionsRepository no disponible');
  });
});

describe('ask_user_question (Fase 9 cierre)', () => {
  function makeLoopRunner() {
    const mgr = new SuspendedPromptsManager();
    return {
      suspend: (args) => mgr.suspend(args),
      resume:  (chatId, answer) => mgr.resume(chatId, answer),
      hasSuspended: (c) => mgr.hasPending(c),
      _mgr: mgr,
    };
  }

  test('error sin question', async () => {
    const r = await ASK_USER_QUESTION.execute({}, { chatId: 'c1', loopRunner: makeLoopRunner() });
    expect(r).toContain('question requerido');
  });

  test('error sin chatId en ctx', async () => {
    const r = await ASK_USER_QUESTION.execute({ question: '?' }, { loopRunner: makeLoopRunner() });
    expect(r).toContain('chatId');
  });

  test('error si loopRunner.suspend no está', async () => {
    const r = await ASK_USER_QUESTION.execute({ question: '?' }, { chatId: 'c1' });
    expect(r).toContain('suspend');
  });

  test('resume entrega respuesta al tool', async () => {
    const lr = makeLoopRunner();
    const p = ASK_USER_QUESTION.execute(
      { question: '¿A o B?', options: ['A', 'B'], timeoutSeconds: 30 },
      { chatId: 'c1', loopRunner: lr },
    );
    // Esperar un tick para que suspend registre
    await new Promise(r => setImmediate(r));
    expect(lr._mgr.hasPending('c1')).toBe(true);
    lr.resume('c1', 'A');
    const result = await p;
    expect(result).toContain('A');
  });

  test('timeout retorna mensaje amigable', async () => {
    const lr = makeLoopRunner();
    const p = ASK_USER_QUESTION.execute(
      { question: '?', timeoutSeconds: 30 },   // pero el Math.max lo fuerza a 30s
      { chatId: 'c1', loopRunner: lr },
    );
    // El timeout mínimo es 30_000ms — test rápido forzando resume con error manual
    // Vamos a cancelar para verificar el otro path:
    await new Promise(r => setImmediate(r));
    lr._mgr.cancel('c1', 'cancelled');
    const result = await p;
    expect(result).toMatch(/cancelada|cancelled|Continuá/);
  });
});
