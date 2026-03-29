export interface ChatButton {
  text: string;
  callback_data: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tts';
  content?: string;
  streaming?: boolean;
  error?: boolean;
  buttons?: ChatButton[];
  askPermission?: boolean;
  audioUrl?: string;
  transcription?: string;
  msgId?: string;
  mediaType?: 'photo' | 'document' | 'voice' | 'video';
  mediaSrc?: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
}
