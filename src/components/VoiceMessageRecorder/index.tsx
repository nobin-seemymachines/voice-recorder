import React, { useRef, useState } from "react";
import styles from "./index.module.scss";

function isAndroid() {
  return /Android/.test(navigator.userAgent);
}
const getBlobType = () => {
  if (isAndroid()) return "audio/webm";
  return "audio/mp4";
};
const isAudioRecordingSupported = () => {
  return !!(
    typeof window !== "undefined" &&
    navigator.mediaDevices &&
    typeof window.MediaRecorder !== "undefined"
  );
};

// PCM to WAV encoder, 16-bit mono
function encodeWAV(samples: Float32Array[], sampleRate: number) {
  // Flatten Float32Array[]
  const flat = Float32Array.from(samples.flat());
  const buffer = new ArrayBuffer(44 + flat.length * 2);
  const view = new DataView(buffer);
  function writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  }
  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + flat.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // AudioFormat PCM
  view.setUint16(22, 1, true); // NumChannels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, flat.length * 2, true);
  // PCM samples
  for (let i = 0, offset = 44; i < flat.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, flat[i])); // clamp
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

const VoiceMessageRecorder: React.FC = () => {
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(false);
  const [uploadSrc, setUploadSrc] = useState<string | null>(null);
  const [isWavFallback, setIsWavFallback] = useState(false);
  const [audioMime, setAudioMime] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Web Audio fallback
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const bufferRef = useRef<Float32Array[]>([]);
  const wavStreamRef = useRef<MediaStream | null>(null);
  const wavSampleRateRef = useRef<number>(44100);

  const startRecording = async () => {
    setError(null);
    setAudioMime(null);
    setIsWavFallback(false);
    bufferRef.current = [];

    // Use MediaRecorder for all browsers that support it (including mobile Chrome)
    if (isAudioRecordingSupported()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const mimeType = getBlobType();
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch (mediaTypeError) {
          recorder = new MediaRecorder(stream);
        }
        audioChunksRef.current = [];
        recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
        recorder.onerror = (e) => {
          setError(
            "Recording failed: " +
              (e.error?.message || e.error || "Unknown error.")
          );
          setRecording(false);
          setPulse(false);
          stream.getTracks().forEach((t) => t.stop());
        };
        recorder.onstop = () => {
          const type = getBlobType();
          const blob = new Blob(audioChunksRef.current, { type });
          setAudioUrl(URL.createObjectURL(blob));
          setAudioMime(type);
          stream.getTracks().forEach((t) => t.stop());
        };
        mediaRecorderRef.current = recorder;
        try {
          recorder.start();
        } catch (err) {
          setError("Recording could not be started on this browser/device.");
          setRecording(false);
          setPulse(false);
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setAudioUrl(null);
        setRecording(true);
        setPulse(true);
        setIsWavFallback(false);
      } catch (err: any) {
        setError("Microphone access denied or not supported.");
      }
    } else {
      // Only use Web Audio PCM + WAV fallback for browsers that truly don't support MediaRecorder
      setIsWavFallback(true);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        wavStreamRef.current = stream;
        const audioCtx = new (window.AudioContext ||
          (window as any).webkitAudioContext)();
        audioContextRef.current = audioCtx;
        wavSampleRateRef.current = audioCtx.sampleRate;
        const input = audioCtx.createMediaStreamSource(stream);
        inputRef.current = input;
        // Use buffer size 4096, 1 channel
        const proc = audioCtx.createScriptProcessor(4096, 1, 1);
        procRef.current = proc;
        proc.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          bufferRef.current.push(new Float32Array(inputData));
        };
        input.connect(proc);
        proc.connect(audioCtx.destination);
        setAudioUrl(null);
        setRecording(true);
        setPulse(true);
      } catch (err: any) {
        setError(
          "Microphone access denied or not supported (WAV fallback failed)."
        );
      }
    }
  };

  const stopRecording = () => {
    setRecording(false);
    setPulse(false);
    // Wav fallback clean up and export
    if (
      isWavFallback &&
      audioContextRef.current &&
      procRef.current &&
      inputRef.current &&
      wavStreamRef.current
    ) {
      procRef.current.disconnect();
      inputRef.current.disconnect();
      audioContextRef.current.close();
      wavStreamRef.current.getTracks().forEach((t) => t.stop());
      const blob = encodeWAV(bufferRef.current, wavSampleRateRef.current);
      setAudioUrl(URL.createObjectURL(blob));
      setAudioMime("audio/wav");
      // Clear refs
      procRef.current = null;
      inputRef.current = null;
      audioContextRef.current = null;
      wavStreamRef.current = null;
      bufferRef.current = [];
      return;
    }
    // MediaRecorder path
    mediaRecorderRef.current?.stop();
  };

  const reset = () => {
    setAudioUrl(null);
    setAudioMime(null);
    setError(null);
    setRecording(false);
    setPulse(false);
    setUploadSrc(null);
    setIsWavFallback(false);
    bufferRef.current = [];
    // Clean up any still-open Web Audio fallback
    procRef.current?.disconnect();
    inputRef.current?.disconnect();
    audioContextRef.current?.close();
    wavStreamRef.current?.getTracks().forEach((t) => t.stop());
    procRef.current = null;
    inputRef.current = null;
    audioContextRef.current = null;
    wavStreamRef.current = null;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setUploadSrc(URL.createObjectURL(file));
      setAudioUrl(null);
      setAudioMime(file.type);
      setError(null);
    }
  };

  // File name for download
  const fileExt =
    audioMime === "audio/wav"
      ? ".wav"
      : audioMime === "audio/webm"
      ? ".webm"
      : ".mp4";

  return (
    <div className={styles.voiceMessageRecorder}>
      <p className={styles.heading}>
        Tap to{" "}
        <span className={styles.bold}>{recording ? "STOP" : "START"}</span>{" "}
        recording
      </p>
      <button
        className={styles.micButton + (pulse ? " " + styles.pulse : "")}
        onClick={recording ? stopRecording : startRecording}
        aria-label={recording ? "Stop recording" : "Start recording"}
        disabled={recording && isWavFallback && !audioContextRef.current} // prevent double-stop
      >
        <svg width={120} height={120} viewBox="0 0 120 120">
          <circle
            cx="60"
            cy="60"
            r="56"
            stroke="#902EE6"
            strokeWidth="8"
            fill="white"
          />
          <path
            d="M60 38c-6.627 0-12 5.373-12 12v16c0 6.627 5.373 12 12 12s12-5.373 12-12V50c0-6.627-5.373-12-12-12zm-3 46.9v5.1h6v-5.1A24.02 24.02 0 0 0 84 62h-6a18 18 0 1 1-36 0h-6a24.02 24.02 0 0 0 21 22.9z"
            fill="#902EE6"
          />
        </svg>
      </button>
      {error && <p className={styles.error}>{error}</p>}
      {/* Output recorded audio (native or fallback), with download/delete */}
      {audioUrl && !recording && (
        <div className={styles.audioPreview}>
          <audio controls src={audioUrl} />
          <a
            href={audioUrl}
            download={`voice-message${fileExt}`}
            className={styles.delete}
            style={{
              background: "#0ea5e9",
              color: "white",
              marginLeft: 8,
              marginRight: 8,
            }}
          >
            Download
          </a>
          <button className={styles.delete} onClick={reset}>
            Delete
          </button>
        </div>
      )}
      {/* Upload fallback - only show if MediaRecorder is not supported */}
      {!recording && !audioUrl && !isAudioRecordingSupported() && (
        <div className={styles.audioPreview}>
          <span>Upload audio file:</span>
          <input type="file" accept="audio/*" onChange={handleFileUpload} />
          {uploadSrc && (
            <div className={styles.audioPreview}>
              <audio controls src={uploadSrc} />
              <button className={styles.delete} onClick={reset}>
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VoiceMessageRecorder;
