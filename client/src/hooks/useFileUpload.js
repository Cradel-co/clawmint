import { useRef, useCallback } from 'react';

/**
 * Hook para manejo de upload de archivos (click + drag & drop).
 * Retorna ref del input file y handlers.
 */
export default function useFileUpload({ onFile }) {
  const fileInputRef = useRef(null);

  const openPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const processFile = useCallback((file, inputText) => {
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type || 'application/octet-stream';
      onFile?.({ file, base64, mediaType, isImage, inputText });
    };
    reader.onerror = () => {
      onFile?.({ error: `Error leyendo archivo: ${file.name}` });
    };
    reader.readAsDataURL(file);
  }, [onFile]);

  const handleFileSelect = useCallback((e, inputText = '') => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    processFile(files[0], inputText);
    e.target.value = '';
  }, [processFile]);

  const handleDrop = useCallback((e, inputText = '') => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    processFile(files[0], inputText);
  }, [processFile]);

  const handleDragOver = useCallback((e) => e.preventDefault(), []);

  return { fileInputRef, openPicker, handleFileSelect, handleDrop, handleDragOver };
}
