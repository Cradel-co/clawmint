import { useRef, useCallback } from 'react';

interface FileResult {
  file?: File;
  base64?: string;
  mediaType?: string;
  isImage?: boolean;
  inputText?: string;
  error?: string;
}

interface UseFileUploadOptions {
  onFile?: (result: FileResult) => void;
}

export default function useFileUpload({ onFile }: UseFileUploadOptions) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const processFile = useCallback((file: File, inputText: string) => {
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      const mediaType = file.type || 'application/octet-stream';
      onFile?.({ file, base64, mediaType, isImage, inputText });
    };
    reader.onerror = () => {
      onFile?.({ error: `Error leyendo archivo: ${file.name}` });
    };
    reader.readAsDataURL(file);
  }, [onFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, inputText = '') => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    processFile(files[0], inputText);
    e.target.value = '';
  }, [processFile]);

  const handleDrop = useCallback((e: React.DragEvent, inputText = '') => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    processFile(files[0], inputText);
  }, [processFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);

  return { fileInputRef, openPicker, handleFileSelect, handleDrop, handleDragOver };
}
