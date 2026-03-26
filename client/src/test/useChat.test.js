import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useChat from '../hooks/useChat.js';

describe('useChat', () => {
  it('initializes with default state', () => {
    const { result } = renderHook(() => useChat({}));
    expect(result.current.messages).toEqual([]);
    expect(result.current.input).toBe('');
    expect(result.current.sending).toBe(false);
    expect(result.current.provider).toBe('anthropic');
    expect(result.current.agent).toBeNull();
    expect(result.current.cwd).toBe('~');
    expect(result.current.statusText).toBeNull();
  });

  it('addUserMessage adds a user message', () => {
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.addUserMessage('Hello'));
    expect(result.current.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('addUserMessage with extra props', () => {
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.addUserMessage('Audio', { audioUrl: 'blob:123' }));
    expect(result.current.messages[0]).toEqual({ role: 'user', content: 'Audio', audioUrl: 'blob:123' });
  });

  it('clearMessages empties the messages array', () => {
    const { result } = renderHook(() => useChat({}));
    act(() => result.current.addUserMessage('msg1'));
    act(() => result.current.addUserMessage('msg2'));
    expect(result.current.messages).toHaveLength(2);
    act(() => result.current.clearMessages());
    expect(result.current.messages).toEqual([]);
  });

  describe('handleWsMessage', () => {
    it('chat_chunk creates a new streaming message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_chunk', text: 'Hello' }));
      expect(result.current.messages).toEqual([
        { role: 'assistant', content: 'Hello', streaming: true },
      ]);
    });

    it('chat_chunk updates the last streaming message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_chunk', text: 'Hel' }));
      act(() => result.current.handleWsMessage({ type: 'chat_chunk', text: 'Hello world' }));
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('Hello world');
      expect(result.current.messages[0].streaming).toBe(true);
    });

    it('chat_done finalizes a streaming message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => {
        result.current.setSending(true);
        result.current.handleWsMessage({ type: 'chat_chunk', text: 'Partial' });
      });
      act(() => result.current.handleWsMessage({ type: 'chat_done', text: 'Complete answer' }));
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('Complete answer');
      expect(result.current.messages[0].streaming).toBe(false);
      expect(result.current.sending).toBe(false);
    });

    it('chat_done with buttons', () => {
      const { result } = renderHook(() => useChat({}));
      const buttons = [{ text: 'OK', callback_data: 'ok' }];
      act(() => result.current.handleWsMessage({ type: 'chat_done', text: 'Pick one', buttons }));
      expect(result.current.messages[0].buttons).toEqual(buttons);
    });

    it('chat_error adds system error message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_error', error: 'Rate limit' }));
      expect(result.current.messages[0]).toEqual({
        role: 'system', content: 'Error: Rate limit', error: true,
      });
      expect(result.current.sending).toBe(false);
    });

    it('command_result adds system message and updates state', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({
        type: 'command_result', text: 'Provider cambiado', provider: 'gemini', cwd: '/home',
      }));
      expect(result.current.messages[0].content).toBe('Provider cambiado');
      expect(result.current.provider).toBe('gemini');
      expect(result.current.cwd).toBe('/home');
    });

    it('history_restore replaces messages', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.addUserMessage('old msg'));
      act(() => result.current.handleWsMessage({
        type: 'history_restore',
        messages: [
          { role: 'user', content: 'restored1' },
          { role: 'assistant', content: 'restored2' },
        ],
      }));
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].content).toBe('restored1');
    });

    it('chat_status sets status text for thinking', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_status', status: 'thinking' }));
      expect(result.current.statusText).toBe('🤔 Pensando...');
    });

    it('chat_status sets status text for tool_use', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_status', status: 'tool_use', detail: 'bash' }));
      expect(result.current.statusText).toBe('⚡ bash...');
    });

    it('chat_status clears status for unknown status', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_status', status: 'done' }));
      expect(result.current.statusText).toBeNull();
    });

    it('chat_ask_permission adds permission request message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({
        type: 'chat_ask_permission', tool: 'bash', args: 'ls -la',
        approveId: 'approve-1', rejectId: 'reject-1',
      }));
      const msg = result.current.messages[0];
      expect(msg.askPermission).toBe(true);
      expect(msg.buttons).toHaveLength(2);
      expect(msg.buttons[0].callback_data).toBe('approve-1');
    });

    it('chat:photo adds photo message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({
        type: 'chat:photo', data: 'base64data', mimeType: 'image/png',
        msgId: 'p1', caption: 'A photo', filename: 'test.png',
      }));
      const msg = result.current.messages[0];
      expect(msg.mediaType).toBe('photo');
      expect(msg.mediaSrc).toContain('data:image/png;base64,');
      expect(msg.caption).toBe('A photo');
    });

    it('chat:delete removes message by msgId', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => {
        result.current.handleWsMessage({ type: 'chat:photo', data: 'x', msgId: 'del1' });
        result.current.handleWsMessage({ type: 'chat:photo', data: 'y', msgId: 'keep1' });
      });
      expect(result.current.messages).toHaveLength(2);
      act(() => result.current.handleWsMessage({ type: 'chat:delete', msgId: 'del1' }));
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].msgId).toBe('keep1');
    });

    it('chat:edit updates message content by msgId', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'chat_done', text: 'original', msgId: 'e1' }));
      // chat_done doesn't set msgId, so let's set it manually
      act(() => result.current.setMessages([{ role: 'assistant', content: 'original', msgId: 'e1' }]));
      act(() => result.current.handleWsMessage({ type: 'chat:edit', msgId: 'e1', text: 'edited' }));
      expect(result.current.messages[0].content).toBe('edited');
    });

    it('status updates provider, agent, cwd', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({
        type: 'status', provider: 'openai', agent: 'coder', cwd: '/tmp',
      }));
      expect(result.current.provider).toBe('openai');
      expect(result.current.agent).toBe('coder');
      expect(result.current.cwd).toBe('/tmp');
    });

    it('delegates auth messages to onAuthMessage', () => {
      const onAuthMessage = vi.fn();
      const { result } = renderHook(() => useChat({ onAuthMessage }));
      act(() => result.current.handleWsMessage({ type: 'session_id', id: 'abc' }));
      expect(onAuthMessage).toHaveBeenCalledWith({ type: 'session_id', id: 'abc' });
    });

    it('chat:transcription updates existing audio message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.setMessages([
        { role: 'user', audioUrl: 'blob:1', transcription: null },
      ]));
      act(() => result.current.handleWsMessage({ type: 'chat:transcription', text: 'Hola mundo' }));
      expect(result.current.messages[0].transcription).toBe('Hola mundo');
    });

    it('session_taken adds error message', () => {
      const { result } = renderHook(() => useChat({}));
      act(() => result.current.handleWsMessage({ type: 'session_taken', message: 'Otro dispositivo' }));
      expect(result.current.messages[0].content).toBe('Otro dispositivo');
      expect(result.current.messages[0].error).toBe(true);
    });
  });
});
