import React, { useState, useRef, useEffect, useImperativeHandle } from "react";
import styles from "./AudioRecorder.module.scss";
import { FaMicrophone } from "react-icons/fa";
import { BsPlayFill, BsPauseFill } from "react-icons/bs";
// lamejs is loaded dynamically to ensure correct interop in all bundlers/browsers

// Type definitions
type RecordingStatus =
  | "idle"
  | "permission_pending"
  | "recording"
  | "stopped"
  | "error";

interface AudioRecorderState {
  status: RecordingStatus;
  audioBlob: Blob | null;
  audioURL: string | null;
  errorMessage: string | null;
  isProcessing: boolean;
}

export interface AudioRecorderProps {
  onUpload?: (file: File) => Promise<void> | void;
  onError?: (message: string) => void;
  // Optional maximum recording duration in seconds; shows a countdown timer
  maxDurationSeconds?: number;
  onStatusChange?: (status: RecordingStatus, hasAudio: boolean) => void;
  // Callback when user saves the recording (passes the File object)
  onSave?: (file: File) => void;
}

export interface AudioRecorderHandle {
  upload: () => Promise<void>;
  reset: () => void;
  getMp3Blob: () => Promise<Blob>;
  readonly audioBlob: Blob | null;
  readonly isProcessing: boolean;
  readonly status: RecordingStatus;
}

const AudioRecorder = React.forwardRef<AudioRecorderHandle, AudioRecorderProps>(
  ({ onUpload, onError, maxDurationSeconds, onStatusChange, onSave }, ref) => {
    // State management
    const [state, setState] = useState<AudioRecorderState>({
      status: "idle",
      audioBlob: null,
      audioURL: null,
      errorMessage: null,
      isProcessing: false,
    });

    // Refs
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    // Fallback (Web Audio API) refs
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const pcmBuffersRef = useRef<Float32Array[]>([]);
    const captureModeRef = useRef<"mediarecorder" | "webaudio" | null>(null);

    const startedAtRef = useRef<number | null>(null);
    const [elapsedSec, setElapsedSec] = useState<number>(0);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const playbackRafIdRef = useRef<number | null>(null);
    const [playbackSec, setPlaybackSec] = useState<number>(0);
    const [durationSec, setDurationSec] = useState<number>(0);
    const [isPlaying, setIsPlaying] = useState<boolean>(false);

    // Browser compatibility check
    useEffect(() => {
      const checkBrowserSupport = () => {
        // Check if we're in a secure context (HTTPS or localhost)
        const isSecureContext =
          window.isSecureContext ||
          window.location.protocol === "https:" ||
          window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1";

        if (!isSecureContext) {
          setState((prev) => ({
            ...prev,
            status: "error",
            errorMessage:
              "Audio recording requires HTTPS or localhost. Please use a secure connection.",
          }));
          return;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setState((prev) => ({
            ...prev,
            status: "error",
            errorMessage:
              "Your browser does not support audio recording. Please use a modern browser like Chrome, Firefox, Safari, or Edge.",
          }));
          return;
        }

        // If MediaRecorder is missing, we will fallback to Web Audio; no error here
      };

      checkBrowserSupport();
    }, []);

    // simple recording timer (increments elapsed every 500ms)
    useEffect(() => {
      if (state.status !== "recording") return;
      startedAtRef.current = Date.now();
      const id = window.setInterval(() => {
        if (startedAtRef.current) {
          setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
        }
      }, 500);
      return () => {
        window.clearInterval(id);
        startedAtRef.current = null;
        setElapsedSec(0);
      };
    }, [state.status]);

    // Auto-stop when reaching maxDurationSeconds
    useEffect(() => {
      if (state.status !== "recording" || !maxDurationSeconds) return;
      if (elapsedSec >= maxDurationSeconds) {
        stopRecording();
      }
    }, [elapsedSec, state.status, maxDurationSeconds]);

    const formatCountdown = (elapsed: number): string => {
      if (!maxDurationSeconds) return `${elapsed}s`;
      const remaining = Math.max(0, maxDurationSeconds - elapsed);
      if (remaining >= 60) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const secsStr = secs.toString().padStart(2, "0");
        return `${mins}.${secsStr}m left`;
      }
      return `${remaining}s left`;
    };

    // Cleanup function
    useEffect(() => {
      return () => {
        if (state.audioURL) {
          URL.revokeObjectURL(state.audioURL);
        }
        // Stop any active nodes/streams
        try {
          processorRef.current?.disconnect();
          sourceNodeRef.current?.disconnect();
          audioContextRef.current?.close();
        } catch {}
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      };
    }, [state.audioURL]);

    // Request permission and start recording
    const requestPermissionAndStart = async (): Promise<void> => {
      try {
        setState((prev) => ({ ...prev, status: "permission_pending" }));

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        mediaStreamRef.current = stream;

        if (window.MediaRecorder) {
          // MediaRecorder path
          const mediaRecorder = new MediaRecorder(stream);
          mediaRecorderRef.current = mediaRecorder;
          captureModeRef.current = "mediarecorder";

          audioChunksRef.current = [];
          mediaRecorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size > 0) {
              audioChunksRef.current.push(event.data);
            }
          };
          mediaRecorder.onstop = () => {
            handleRecordingStop();
          };
          mediaRecorder.start();
        } else {
          // Web Audio fallback
          captureModeRef.current = "webaudio";
          const audioContext = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
          audioContextRef.current = audioContext;
          if (audioContext.state === "suspended") {
            try {
              await audioContext.resume();
            } catch {}
          }
          const source = audioContext.createMediaStreamSource(stream);
          sourceNodeRef.current = source;
          const processor = audioContext.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          pcmBuffersRef.current = [];
          processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            pcmBuffersRef.current.push(new Float32Array(input));
          };
          source.connect(processor);
          processor.connect(audioContext.destination);
        }
        setState((prev) => ({ ...prev, status: "recording" }));
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Microphone permission denied.";
        setState((prev) => ({
          ...prev,
          status: "error",
          errorMessage: `Microphone access denied: ${errorMessage}`,
        }));
        onError?.(`Microphone access denied: ${errorMessage}`);
      }
    };

    // Handle recording stop
    const handleRecordingStop = (): void => {
      if (captureModeRef.current === "mediarecorder") {
        // iOS Safari prefers MP4/AAC over WebM
        const isIOS =
          /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.userAgent.includes("Mac") &&
            (navigator as any).maxTouchPoints > 2);

        const blobType = isIOS ? "audio/mp4" : "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: blobType });
        const audioURL = URL.createObjectURL(audioBlob);
        setState((prev) => ({
          ...prev,
          audioBlob,
          audioURL,
          status: "stopped",
        }));
        return;
      }
      // Web Audio fallback: build WAV for preview
      const sampleRate = audioContextRef.current?.sampleRate || 44100;
      const wavBlob = buildWavFromFloat32(pcmBuffersRef.current, sampleRate);
      const wavURL = URL.createObjectURL(wavBlob);
      setState((prev) => ({
        ...prev,
        audioBlob: wavBlob,
        audioURL: wavURL,
        status: "stopped",
      }));
    };

    // iOS Safari audio playback fix
    const handleAudioPlay = async (): Promise<void> => {
      setIsPlaying(true);
      // Resume any suspended audio context on iOS
      if (
        audioContextRef.current &&
        audioContextRef.current.state === "suspended"
      ) {
        try {
          await audioContextRef.current.resume();
        } catch {}
      }
      // Start RAF-based playback ticker for mobile where timeupdate is sparse
      startPlaybackTicker();
      // Ensure duration becomes finite on iOS for blob URLs
      const el = audioElRef.current;
      if (el) ensureFiniteDuration(el);
    };

    // Reset audio player when playback ends
    const handleAudioEnded = (): void => {
      const el = audioElRef.current;
      if (!el) return;
      try {
        el.pause();
        el.currentTime = 0;
        setPlaybackSec(0);
      } catch {}
      setIsPlaying(false);
      stopPlaybackTicker();
    };

    const handleAudioPause = (): void => {
      setIsPlaying(false);
      stopPlaybackTicker();
    };

    // Toggle play/pause
    const togglePlayPause = async (): Promise<void> => {
      const el = audioElRef.current;
      if (!el) return;

      if (isPlaying) {
        el.pause();
      } else {
        await el.play();
      }
    };

    const startPlaybackTicker = (): void => {
      stopPlaybackTicker();
      const tick = () => {
        if (audioElRef.current) {
          setPlaybackSec(audioElRef.current.currentTime || 0);
        }
        playbackRafIdRef.current = window.requestAnimationFrame(tick);
      };
      playbackRafIdRef.current = window.requestAnimationFrame(tick);
    };

    const stopPlaybackTicker = (): void => {
      if (playbackRafIdRef.current !== null) {
        window.cancelAnimationFrame(playbackRafIdRef.current);
        playbackRafIdRef.current = null;
      }
    };

    const ensureFiniteDuration = (el: HTMLAudioElement): void => {
      const d = el.duration;
      if (!isFinite(d) || d === 0) {
        const handleSeeked = () => {
          setDurationSec(isFinite(el.duration) ? el.duration : 0);
          el.currentTime = 0;
          el.removeEventListener("seeked", handleSeeked);
        };
        try {
          el.addEventListener("seeked", handleSeeked, { once: true } as any);
          el.currentTime = 1e7; // jump far to force duration calculation on iOS
        } catch {
          // no-op
        }
      } else {
        setDurationSec(d);
      }
    };

    // Stop recording
    const stopRecording = (): void => {
      if (state.status !== "recording") return;
      if (captureModeRef.current === "mediarecorder") {
        if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
        return;
      }
      try {
        processorRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        audioContextRef.current?.suspend();
      } catch {}
      handleRecordingStop();
    };

    // Build MP3 Blob from current audio
    const getMp3Blob = async (): Promise<Blob> => {
      if (!state.audioBlob) throw new Error("No audio to process");
      const arrayBuffer = await state.audioBlob.arrayBuffer();
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      if (audioContext.state === "suspended") {
        try {
          await audioContext.resume();
        } catch {}
      }
      const audioBuffer: AudioBuffer = await new Promise((resolve, reject) => {
        const maybe = (audioContext as any).decodeAudioData(
          arrayBuffer,
          (buf: AudioBuffer) => resolve(buf),
          (err: any) => reject(err)
        );
        if (maybe && typeof maybe.then === "function")
          maybe.then(resolve).catch(reject);
      });

      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel =
        audioBuffer.numberOfChannels > 1
          ? audioBuffer.getChannelData(1)
          : leftChannel;
      const leftInt16 = new Int16Array(leftChannel.length);
      const rightInt16 = new Int16Array(rightChannel.length);
      for (let i = 0; i < leftChannel.length; i++) {
        leftInt16[i] = Math.max(
          -32768,
          Math.min(32767, leftChannel[i] * 32768)
        );
        rightInt16[i] = Math.max(
          -32768,
          Math.min(32767, rightChannel[i] * 32768)
        );
      }
      if (!(window as any).lamejs) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load lamejs"));
          document.head.appendChild(s);
        });
      }
      const lamejs = (window as any).lamejs;
      const encoder = new lamejs.Mp3Encoder(2, audioBuffer.sampleRate, 128);
      const mp3Chunks: Uint8Array[] = [];
      const frame = 1152;
      for (let i = 0; i < leftInt16.length; i += frame) {
        const out = encoder.encodeBuffer(
          leftInt16.subarray(i, i + frame),
          rightInt16.subarray(i, i + frame)
        );
        if (out && out.length) mp3Chunks.push(new Uint8Array(out));
      }
      const end = encoder.flush();
      if (end && end.length) mp3Chunks.push(new Uint8Array(end));
      let total = 0;
      mp3Chunks.forEach((c) => (total += c.length));
      const all = new Uint8Array(total);
      let off = 0;
      mp3Chunks.forEach((c) => {
        all.set(c, off);
        off += c.length;
      });
      return new Blob([all], { type: "audio/mpeg" });
    };

    // Upload callback wrapper
    const uploadMp3 = async (): Promise<void> => {
      if (!state.audioBlob || !onUpload) return;
      try {
        setState((p) => ({ ...p, isProcessing: true }));
        const mp3 = await getMp3Blob();
        const filename = `voice-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/:/g, "-")}.mp3`;
        const file = new File([mp3], filename, { type: "audio/mpeg" });
        await onUpload(file);
        setState((p) => ({ ...p, isProcessing: false }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState((p) => ({
          ...p,
          isProcessing: false,
          status: "error",
          errorMessage: msg,
        }));
        onError?.(msg);
      }
    };

    // Save callback wrapper
    const handleSave = async (): Promise<void> => {
      if (!state.audioBlob || !onSave) return;
      try {
        setState((p) => ({ ...p, isProcessing: true }));
        const mp3 = await getMp3Blob();
        const filename = `VOICE-${Date.now()}.mp3`;
        const file = new File([mp3], filename, { type: "audio/mpeg" });
        onSave(file);
        setState((p) => ({ ...p, isProcessing: false }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState((p) => ({
          ...p,
          isProcessing: false,
          status: "error",
          errorMessage: msg,
        }));
        onError?.(msg);
      }
    };

    // Download as MP3
    // const downloadAsMP3 = async (): Promise<void> => {
    //   if (!state.audioBlob) return;

    //   try {
    //     setState((prev) => ({ ...prev, isProcessing: true }));

    //     // Read audio blob into AudioBuffer
    //     const arrayBuffer = await state.audioBlob.arrayBuffer();
    //     const audioContext = new (window.AudioContext ||
    //       (window as any).webkitAudioContext)();

    //     // Resume audio context if suspended (iOS Safari requirement)
    //     if (audioContext.state === "suspended") {
    //       await audioContext.resume();
    //     }

    //     const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    //     // Get raw audio data
    //     const leftChannel = audioBuffer.getChannelData(0);
    //     const rightChannel =
    //       audioBuffer.numberOfChannels > 1
    //         ? audioBuffer.getChannelData(1)
    //         : leftChannel;

    //     // Convert float32 to int16
    //     const leftInt16 = new Int16Array(leftChannel.length);
    //     const rightInt16 = new Int16Array(rightChannel.length);

    //     for (let i = 0; i < leftChannel.length; i++) {
    //       leftInt16[i] = Math.max(
    //         -32768,
    //         Math.min(32767, leftChannel[i] * 32768)
    //       );
    //       rightInt16[i] = Math.max(
    //         -32768,
    //         Math.min(32767, rightChannel[i] * 32768)
    //       );
    //     }

    //     // Initialize MP3 encoder (load lamejs as script to avoid module issues)
    //     // Check if lamejs is already loaded globally
    //     if (!(window as any).lamejs) {
    //       // Load lamejs dynamically as a script
    //       await new Promise<void>((resolve, reject) => {
    //         const script = document.createElement("script");
    //         script.src =
    //           "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
    //         script.onload = () => resolve();
    //         script.onerror = () => reject(new Error("Failed to load lamejs"));
    //         document.head.appendChild(script);
    //       });
    //     }

    //     const lamejs = (window as any).lamejs;
    //     if (!lamejs || !lamejs.Mp3Encoder) {
    //       throw new Error("lamejs Mp3Encoder not available");
    //     }

    //     // Create encoder instance
    //     const encoder = new lamejs.Mp3Encoder(2, audioBuffer.sampleRate, 128); // 2 channels, 128kbps

    //     // Process audio data in chunks
    //     const mp3Chunks: Uint8Array[] = [];
    //     const samplesPerFrame = 1152; // MP3 frame size

    //     for (let i = 0; i < leftInt16.length; i += samplesPerFrame) {
    //       const leftFrame = leftInt16.subarray(i, i + samplesPerFrame);
    //       const rightFrame = rightInt16.subarray(i, i + samplesPerFrame);

    //       const mp3Data = encoder.encodeBuffer(leftFrame, rightFrame);
    //       if (mp3Data && mp3Data.length > 0) {
    //         mp3Chunks.push(new Uint8Array(mp3Data));
    //       }
    //     }

    //     // Flush encoder to get final data
    //     const finalData = encoder.flush();
    //     if (finalData && finalData.length > 0) {
    //       mp3Chunks.push(new Uint8Array(finalData));
    //     }

    //     // Concatenate all MP3 chunks
    //     let totalLength = 0;
    //     mp3Chunks.forEach((chunk) => {
    //       totalLength += chunk.length;
    //     });

    //     const mp3DataAll = new Uint8Array(totalLength);
    //     let offset = 0;
    //     mp3Chunks.forEach((chunk) => {
    //       mp3DataAll.set(chunk, offset);
    //       offset += chunk.length;
    //     });

    //     // Create MP3 blob
    //     const mp3Blob = new Blob([mp3DataAll], { type: "audio/mp3" });

    //     // Download logic
    //     const mp3Url = URL.createObjectURL(mp3Blob);
    //     const link = document.createElement("a");
    //     link.href = mp3Url;
    //     link.download = "recording.mp3";
    //     document.body.appendChild(link);
    //     link.click();
    //     document.body.removeChild(link);
    //     URL.revokeObjectURL(mp3Url);

    //     setState((prev) => ({ ...prev, isProcessing: false }));
    //   } catch (error) {
    //     const errorMessage =
    //       error instanceof Error ? error.message : "Failed to process audio";
    //     setState((prev) => ({
    //       ...prev,
    //       status: "error",
    //       errorMessage: `Download failed: ${errorMessage}`,
    //       isProcessing: false,
    //     }));
    //   }
    // };

    // Notify parent when status or audio availability changes
    useEffect(() => {
      onStatusChange?.(state.status, !!state.audioBlob);
    }, [state.status, state.audioBlob, onStatusChange]);

    // Reset function
    const reset = (): void => {
      if (state.audioURL) {
        URL.revokeObjectURL(state.audioURL);
      }

      // Stop audio playback if playing
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.currentTime = 0;
      }
      setIsPlaying(false);
      setPlaybackSec(0);
      stopPlaybackTicker();

      setState({
        status: "idle",
        audioBlob: null,
        audioURL: null,
        errorMessage: null,
        isProcessing: false,
      });

      // Clean up refs
      audioChunksRef.current = [];
      mediaRecorderRef.current = null;
      pcmBuffersRef.current = [];
      try {
        processorRef.current?.disconnect();
        sourceNodeRef.current?.disconnect();
        audioContextRef.current?.close();
      } catch {}
      processorRef.current = null;
      sourceNodeRef.current = null;
      audioContextRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      captureModeRef.current = null;
    };

    // Expose imperative API to parent
    useImperativeHandle(
      ref,
      () => ({
        upload: uploadMp3,
        reset,
        getMp3Blob,
        get audioBlob() {
          return state.audioBlob;
        },
        get isProcessing() {
          return state.isProcessing;
        },
        get status() {
          return state.status;
        },
      }),
      [state.audioBlob, state.isProcessing, state.status]
    );

    // Helpers: build a mono WAV from Float32 chunks for preview
    function buildWavFromFloat32(
      chunks: Float32Array[],
      sampleRate: number
    ): Blob {
      let total = 0;
      for (const c of chunks) total += c.length;
      const pcm = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        pcm.set(c, off);
        off += c.length;
      }

      const bytesPerSample = 2; // 16-bit
      const blockAlign = 1 * bytesPerSample; // mono
      const buffer = new ArrayBuffer(44 + pcm.length * bytesPerSample);
      const view = new DataView(buffer);
      writeAscii(view, 0, "RIFF");
      view.setUint32(4, 36 + pcm.length * bytesPerSample, true);
      writeAscii(view, 8, "WAVE");
      writeAscii(view, 12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, 16, true);
      writeAscii(view, 36, "data");
      view.setUint32(40, pcm.length * bytesPerSample, true);
      let idx = 44;
      for (let i = 0; i < pcm.length; i++, idx += 2) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        view.setInt16(idx, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([view], { type: "audio/wav" });
    }

    function writeAscii(view: DataView, offset: number, text: string) {
      for (let i = 0; i < text.length; i++)
        view.setUint8(offset + i, text.charCodeAt(i));
    }

    const formatPlaybackTimer = (
      currentSecs: number,
      totalSecs: number
    ): string => {
      const remaining = Math.max(0, totalSecs - currentSecs);
      const remainingSec = Math.floor(remaining);
      const secsStr = remainingSec.toString().padStart(2, "0");
      return `${secsStr}s`;
    };

    // Render logic
    return (
      <div className={styles.recorderWrapper}>
        {state.status === "idle" && (
          <>
            <p className={styles.recorderWrapper__title}>
              Tap to <b>START</b> recording
            </p>
            <button
              className={styles.recorderWrapper__preRecordButton}
              onClick={requestPermissionAndStart}
              aria-label="Start recording"
            >
              <FaMicrophone size={77} color="#902ee6" />
            </button>
          </>
        )}

        {state.status === "permission_pending" && (
          <>
            <p className={styles.recorderWrapper__title}>Waiting...</p>
            <button
              className={styles.recorderWrapper__preRecordButton}
              onClick={stopRecording}
              aria-label="Stop recording"
            >
              <FaMicrophone size={77} color="#902ee6" />
            </button>
          </>
        )}

        {state.status === "recording" && (
          <>
            <p className={styles.recorderWrapper__title}>
              Tap to <b>STOP</b> recording
            </p>
            <button
              className={styles.recorderWrapper__stopButton}
              onClick={stopRecording}
              aria-label="Stop recording"
            >
              <FaMicrophone size={77} color="#fff" />
            </button>
            <div className={styles.recorderWrapper__countdown}>
              {formatCountdown(elapsedSec)}
            </div>
          </>
        )}

        {state.status === "stopped" && (
          <>
            <p className={styles.recorderWrapper__title}>
              Tap to <b>{isPlaying ? "PAUSE" : "PLAY"}</b> recording
            </p>
            <audio
              className={styles.audioPlayer}
              src={state.audioURL || undefined}
              controls
              onPlay={handleAudioPlay}
              onPause={handleAudioPause}
              onEnded={handleAudioEnded}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget;
                if (!isFinite(el.duration) || el.duration === 0) {
                  ensureFiniteDuration(el);
                } else {
                  setDurationSec(el.duration);
                }
              }}
              onTimeUpdate={(e) => setPlaybackSec(e.currentTarget.currentTime)}
              preload="metadata"
              playsInline
              ref={audioElRef}
            >
              Your browser does not support the audio element.
            </audio>
            <button
              className={
                isPlaying
                  ? styles.recorderWrapper__stopButton
                  : styles.recorderWrapper__preRecordButton
              }
              onClick={togglePlayPause}
              aria-label={isPlaying ? "Pause recording" : "Play recording"}
            >
              {isPlaying ? (
                <BsPauseFill size={64} color="#fff" />
              ) : (
                <BsPlayFill size={64} color="#902ee6" />
              )}
            </button>
            <div className={styles.recorderWrapper__countdown}>
              {formatPlaybackTimer(playbackSec, durationSec || playbackSec)}
            </div>

            <div className={styles.controlsWrapper}>
              <button
                className={styles.buttonSecondary}
                onClick={reset}
                disabled={state.isProcessing}
              >
                Record Again
              </button>
              {onSave && (
                <button
                  className={styles.buttonPrimary}
                  onClick={handleSave}
                  disabled={state.isProcessing}
                >
                  {state.isProcessing ? "Processing..." : "Save"}
                </button>
              )}
            </div>
            {/* 
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <button
                className={`${styles.button}`}
                onClick={downloadAsMP3}
                disabled={state.isProcessing}
                aria-label="Download mp3"
              >
                {state.isProcessing ? "Processing..." : "Download MP3"}
              </button>
            </div> */}
          </>
        )}

        {state.status === "error" && (
          <div className={styles.error}>
            {state.errorMessage}
            {/* <button
              className={`${styles.button} ${styles.buttonSecondary}`}
              onClick={() => {
                console.log("Browser Debug Info:");
                console.log("- isSecureContext:", window.isSecureContext);
                console.log("- protocol:", window.location.protocol);
                console.log("- hostname:", window.location.hostname);
                console.log(
                  "- navigator.mediaDevices:",
                  !!navigator.mediaDevices
                );
                console.log(
                  "- getUserMedia:",
                  !!navigator.mediaDevices?.getUserMedia
                );
                console.log("- MediaRecorder:", !!window.MediaRecorder);
                console.log(
                  "- AudioContext:",
                  !!(window.AudioContext || (window as any).webkitAudioContext)
                );
              }}
              style={{
                marginTop: "1rem",
                fontSize: "0.8rem",
                padding: "0.5rem 1rem",
              }}
            >
              Debug Info (Check Console)
            </button> */}
          </div>
        )}
      </div>
    );
  }
);

export default AudioRecorder;
