import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useFileUpload from '../hooks/useFileUpload.js';

describe('useFileUpload', () => {
  it('returns fileInputRef and handler functions', () => {
    const { result } = renderHook(() => useFileUpload({ onFile: vi.fn() }));
    expect(result.current.fileInputRef).toBeDefined();
    expect(typeof result.current.openPicker).toBe('function');
    expect(typeof result.current.handleFileSelect).toBe('function');
    expect(typeof result.current.handleDrop).toBe('function');
    expect(typeof result.current.handleDragOver).toBe('function');
  });

  it('handleDragOver prevents default', () => {
    const { result } = renderHook(() => useFileUpload({ onFile: vi.fn() }));
    const event = { preventDefault: vi.fn() };
    result.current.handleDragOver(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('handleFileSelect does nothing with no files', () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useFileUpload({ onFile }));
    const event = { target: { files: null, value: '' } };
    result.current.handleFileSelect(event);
    expect(onFile).not.toHaveBeenCalled();
  });

  it('handleDrop prevents default and processes file', () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useFileUpload({ onFile }));

    const file = new File(['hello'], 'test.txt', { type: 'text/plain' });

    // Mock FileReader — capture the instance so we can trigger onloadend
    let readerInstance = null;
    const OriginalFileReader = global.FileReader;
    global.FileReader = class MockFileReader {
      constructor() {
        this.result = 'data:text/plain;base64,aGVsbG8=';
        this.readAsDataURL = vi.fn();
        this.onloadend = null;
        this.onerror = null;
        readerInstance = this;
      }
    };

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: { files: [file] },
    };

    act(() => result.current.handleDrop(event, 'some text'));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(readerInstance).not.toBeNull();

    // Simulate reader completion on the actual instance
    act(() => readerInstance.onloadend());

    expect(onFile).toHaveBeenCalledWith(expect.objectContaining({
      file,
      base64: 'aGVsbG8=',
      mediaType: 'text/plain',
      isImage: false,
      inputText: 'some text',
    }));

    global.FileReader = OriginalFileReader;
  });

  it('handleDrop ignores empty dataTransfer', () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useFileUpload({ onFile }));
    const event = { preventDefault: vi.fn(), dataTransfer: { files: [] } };
    result.current.handleDrop(event);
    expect(onFile).not.toHaveBeenCalled();
  });
});
