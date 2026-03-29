// --- Mensajes recibidos del servidor (WS → Cliente) ---

export interface WsChatChunk {
  type: 'chat_chunk';
  text: string;
}

export interface WsChatDone {
  type: 'chat_done' | 'chat:message';
  text: string;
  buttons?: Array<{ text: string; callback_data: string }>;
}

export interface WsChatError {
  type: 'chat_error';
  error: string;
}

export interface WsCommandResult {
  type: 'command_result';
  text: string;
  provider?: string;
  agent?: string | null;
  cwd?: string;
}

export interface WsHistoryRestore {
  type: 'history_restore';
  messages: Array<{ role: string; content: string }>;
}

export interface WsAuthError {
  type: 'auth_error';
  error?: string;
  code?: string;
  message?: string;
}

export interface WsChatTranscription {
  type: 'chat:transcription';
  text: string;
}

export interface WsChatStatus {
  type: 'chat_status' | 'chat:status';
  status: string;
  detail?: string;
}

export interface WsChatAskPermission {
  type: 'chat_ask_permission';
  tool: string;
  args: string;
  approveId: string;
  rejectId: string;
}

export interface WsChatTtsAudio {
  type: 'chat:tts_audio';
  data: string;
  mimeType?: string;
}

export interface WsChatTtsError {
  type: 'chat:tts_error';
  error?: string;
}

export interface WsChatMedia {
  type: 'chat:photo' | 'chat:document' | 'chat:voice' | 'chat:video';
  data: string;
  mimeType?: string;
  caption?: string;
  filename?: string;
  msgId?: string;
}

export interface WsChatDelete {
  type: 'chat:delete';
  msgId: string;
}

export interface WsChatEdit {
  type: 'chat:edit';
  msgId: string;
  text: string;
}

export interface WsSessionTaken {
  type: 'session_taken';
  message?: string;
}

export interface WsStatus {
  type: 'status';
  provider?: string;
  agent?: string | null;
  cwd?: string;
}

export interface WsSessionId {
  type: 'session_id';
  id: string;
  user?: unknown;
}

export interface WsAuthTokens {
  type: 'auth:tokens';
  accessToken: string;
  refreshToken: string;
}

export interface WsTelegramSession {
  type: 'telegram_session';
  sessionId: string;
  from: string;
}

export type WsIncomingMessage =
  | WsChatChunk
  | WsChatDone
  | WsChatError
  | WsCommandResult
  | WsHistoryRestore
  | WsAuthError
  | WsChatTranscription
  | WsChatStatus
  | WsChatAskPermission
  | WsChatTtsAudio
  | WsChatTtsError
  | WsChatMedia
  | WsChatDelete
  | WsChatEdit
  | WsSessionTaken
  | WsStatus
  | WsSessionId
  | WsAuthTokens
  | WsTelegramSession;

// --- Mensajes enviados al servidor (Cliente → WS) ---

export interface WsSendInit {
  type: 'init';
  sessionType: 'webchat' | 'pty' | 'listener';
  sessionId?: string;
  authToken?: string;
  jwt?: string;
  command?: string;
  provider?: string;
  cols?: number;
  rows?: number;
}

export interface WsSendChat {
  type: 'chat';
  text: string;
  provider?: string;
  agent?: string | null;
  images?: Array<{ data: string; mimeType: string }>;
  files?: Array<{ data: string; name: string; mimeType: string }>;
}

export interface WsSendAudio {
  type: 'chat:audio';
  data: string;
  mimeType: string;
}

export interface WsSendTts {
  type: 'chat:tts';
  text: string;
}

export interface WsSendAction {
  type: 'chat:action';
  data: string;
}

export interface WsSendInput {
  type: 'input';
  data: string;
}

export interface WsSendResize {
  type: 'resize';
  cols: number;
  rows: number;
}

export type WsOutgoingMessage =
  | WsSendInit
  | WsSendChat
  | WsSendAudio
  | WsSendTts
  | WsSendAction
  | WsSendInput
  | WsSendResize;
