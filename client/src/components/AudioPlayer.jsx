import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './AudioPlayer.module.css';

export default function AudioPlayer({ src, knownDuration }) {
  const audioRef = useRef(null);
  const progressRef = useRef(null);
  const rafRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration || 0);

  // Sincronizar currentTime con requestAnimationFrame para fluidez
  useEffect(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio && playing) {
        setCurrentTime(audio.currentTime);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    if (playing) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };

    const onDuration = () => {
      if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };

    audio.addEventListener('ended', onEnded);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('loadedmetadata', onDuration);

    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('loadedmetadata', onDuration);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().then(() => setPlaying(true)).catch(() => {});
    }
  }, [playing]);

  const seekFromEvent = useCallback((e) => {
    const bar = progressRef.current;
    const audio = audioRef.current;
    const dur = duration;
    if (!bar || !audio || !dur) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * dur;
    setCurrentTime(ratio * dur);
  }, [duration]);

  const onPointerDown = useCallback((e) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e);

    const onMove = (ev) => seekFromEvent(ev);
    const onUp = () => {
      e.currentTarget.removeEventListener('pointermove', onMove);
      e.currentTarget.removeEventListener('pointerup', onUp);
    };
    e.currentTarget.addEventListener('pointermove', onMove);
    e.currentTarget.addEventListener('pointerup', onUp);
  }, [duration, seekFromEvent]);

  const fmt = (s) => {
    if (!s || !isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className={styles.container}>
      <audio ref={audioRef} src={src} preload="auto" />
      <button className={styles.playBtn} onClick={togglePlay}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z" />
          </svg>
        )}
      </button>
      <span className={styles.time}>{fmt(currentTime)}</span>
      <div
        className={styles.progress}
        ref={progressRef}
        onPointerDown={onPointerDown}
      >
        <div className={styles.progressBg} />
        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        <div className={styles.progressThumb} style={{ left: `${progress}%` }} />
      </div>
      <span className={styles.time}>{fmt(duration)}</span>
    </div>
  );
}
