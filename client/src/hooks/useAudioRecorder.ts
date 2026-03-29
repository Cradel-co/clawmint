import { useState, useRef, useCallback, useEffect } from 'react';

interface RecordingResult {
  blob: Blob;
  audioUrl: string;
  audioDuration: number;
  mimeType: string;
}

interface UseAudioRecorderOptions {
  onRecordingComplete?: (result: RecordingResult) => void;
}

export default function useAudioRecorder({ onRecordingComplete }: UseAudioRecorderOptions) {
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recTime, setRecTime] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCancelledRef = useRef(false);
  const recTimeRef = useRef(0);

  useEffect(() => {
    if (recording && !recPaused) {
      recTimerRef.current = setInterval(() => {
        setRecTime(t => { recTimeRef.current = t + 1; return t + 1; });
      }, 1000);
    } else {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    }
    return () => { if (recTimerRef.current) clearInterval(recTimerRef.current); };
  }, [recording, recPaused]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      if (recTimerRef.current) clearInterval(recTimerRef.current);
    };
  }, []);

  const cleanupRecording = useCallback(() => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setRecording(false);
    setRecPaused(false);
    setRecTime(0);
  }, []);

  const start = useCallback(async (): Promise<{ error: string | null }> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const hint = !window.isSecureContext
        ? 'Necesitás acceder via HTTPS o localhost para usar el micrófono'
        : 'Tu navegador no soporta grabación de audio';
      return { error: hint };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      recCancelledRef.current = false;
      recTimeRef.current = 0;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (recCancelledRef.current) return;
        const actualMime = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: actualMime });
        const audioUrl = URL.createObjectURL(blob);
        const audioDuration = recTimeRef.current;
        onRecordingComplete?.({ blob, audioUrl, audioDuration, mimeType: actualMime });
      };

      mediaRecorder.start();
      setRecording(true);
      setRecPaused(false);
      setRecTime(0);
      return { error: null };
    } catch (err: any) {
      let errorMsg = 'Micrófono no disponible';
      if (err.name === 'NotAllowedError') errorMsg = 'Permiso de micrófono denegado. Revisá los permisos del navegador';
      else if (err.name === 'NotFoundError') errorMsg = 'No se encontró ningún micrófono';
      else if (err.name === 'NotReadableError') errorMsg = 'El micrófono está siendo usado por otra aplicación';
      return { error: errorMsg };
    }
  }, [onRecordingComplete]);

  const cancel = useCallback(() => {
    recCancelledRef.current = true;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    cleanupRecording();
  }, [cleanupRecording]);

  const togglePause = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (mr.state === 'recording') {
      mr.pause();
      setRecPaused(true);
    } else if (mr.state === 'paused') {
      mr.resume();
      setRecPaused(false);
    }
  }, []);

  const send = useCallback(() => {
    recCancelledRef.current = false;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    setRecording(false);
    setRecPaused(false);
    setRecTime(0);
  }, []);

  return { recording, recPaused, recTime, start, cancel, togglePause, send };
}
