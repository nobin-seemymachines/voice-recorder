import React, { useRef, useState, useEffect } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./VoiceRecorder.module.scss";
import MicrophonePlugin from "wavesurfer.js/dist/plugins/microphone.js";

const VoiceRecorder: React.FC = () => {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState<boolean>(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<WaveSurfer | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  // Timer helpers
  const startTimer = () => {
    timerRef.current = window.setInterval(() => {
      setDuration((prev) => prev + 1);
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Start recording
  const startRecording = async () => {
    if (!navigator.mediaDevices) {
      alert("Media devices not supported!");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorderRef.current = new MediaRecorder(stream);

    mediaRecorderRef.current.ondataavailable = (e) => {
      audioChunks.current.push(e.data);
    };

    mediaRecorderRef.current.onstop = () => {
      const blob = new Blob(audioChunks.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      audioChunks.current = [];

      if (waveform) waveform.load(url);
    };

    mediaRecorderRef.current.start();
    setRecording(true);
    setAudioUrl(null);
    setDuration(0);
    startTimer();

    // Create WaveSurfer with Microphone plugin
    const ws = WaveSurfer.create({
      container: waveformRef.current!,
      waveColor: "#999",
      progressColor: "#4f46e5",
      cursorColor: "#4f46e5",
      height: 80,
      interact: false,
      plugins: [
        MicrophonePlugin.create({
          bufferSize: 4096,
          numberOfInputChannels: 1,
          numberOfOutputChannels: 1,
          constraints: { audio: true },
          waveColor: "#999",
          backgroundColor: "#f5f5f5",
          interact: false,
        }),
      ],
    });

    // Start microphone plugin
    const micPlugin = ws.getActivePlugins()[0] as any;
    await micPlugin.start();

    setWaveform(ws);
  };

  // Stop recording
  const stopRecording = async () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    stopTimer();

    try {
      const micPlugin = waveform?.getActivePlugins()[0] as any;
      if (micPlugin?.stop) await micPlugin.stop();
    } catch (err) {
      console.warn("Mic stop error", err);
    }
  };

  // Reset
  const reset = () => {
    setAudioUrl(null);
    setDuration(0);
    waveform?.destroy();
    setWaveform(null);
  };

  const playPause = () => {
    waveform?.playPause();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  useEffect(() => {
    return () => {
      stopTimer();
      waveform?.destroy();
    };
  }, [waveform]);

  return (
    <div className={styles.voiceRecorder}>
      <div ref={waveformRef} className={styles.waveform}></div>

      <div className={styles.controls}>
        <span className={styles.timer}>{formatTime(duration)}</span>

        {recording ? (
          <button className={styles.stop} onClick={stopRecording}>
            ⏹
          </button>
        ) : audioUrl ? (
          <>
            <button className={styles.play} onClick={playPause}>
              ▶️
            </button>
            <button className={styles.delete} onClick={reset}>
              🗑
            </button>
            <button
              className={styles.send}
              onClick={() => alert("Send audio")}
            >
              📤
            </button>
          </>
        ) : (
          <button className={styles.record} onClick={startRecording}>
            🎤
          </button>
        )}
      </div>
    </div>
  );
};

export default VoiceRecorder;
