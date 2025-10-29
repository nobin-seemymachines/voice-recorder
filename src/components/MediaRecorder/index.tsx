import { useRef, useState } from "react";
import {
  ReactMediaRecorder,
  type ReactMediaRecorderRenderProps,
} from "react-media-recorder";
import { FaMicrophone } from "react-icons/fa";
import styles from "./index.module.scss";

const MediaRecorder = () => {
  const [micScale, setMicScale] = useState(1);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const animationRef = useRef<number | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const downloadAudio = async (audioUrl: string) => {
    const blob = await fetch(audioUrl).then((res) => res.blob());
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "recording.webm";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const startVisualizer = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContextRef.current = new AudioContext();
    analyserRef.current = audioContextRef.current.createAnalyser();
    sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
    sourceRef.current.connect(analyserRef.current);

    analyserRef.current.fftSize = 256;
    const bufferLength = analyserRef.current.frequencyBinCount;
    dataArrayRef.current = new Uint8Array(bufferLength);

    const animate = () => {
      if (!analyserRef.current || !dataArrayRef.current) return;

      // Some TS lib typings use Uint8Array<ArrayBufferLike>; cast to the expected DOM type
      analyserRef.current.getByteFrequencyData(
        dataArrayRef.current as unknown as any
      );
      const avg =
        dataArrayRef.current.reduce((a, b) => a + b, 0) /
        dataArrayRef.current.length;

      // Scale value between 1 and 1.4
      const scale = 1 + Math.min(avg / 1000, 0.4);
      setMicScale(scale);

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();
  };

  const stopVisualizer = () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (audioContextRef.current) audioContextRef.current.close();
    setMicScale(1);
  };

  return (
    <div className={styles.voiceRecorder}>
      <ReactMediaRecorder
        audio
        render={({
          status,
          startRecording,
          stopRecording,
          mediaBlobUrl,
          clearBlobUrl,
        }: ReactMediaRecorderRenderProps) => (
          <div className={styles.recordMain}>
            <p className={styles.status}>
              {status === "recording"
                ? "Tap to STOP recording"
                : "Tap to START recording"}
            </p>

            <span
              className={styles.recordbutton}
              style={{
                backgroundColor: status === "recording" ? "#902EE6" : "#fff",
                transform: `scale(${micScale})`,
                transition: "transform 0.1s ease-out",
              }}
              onClick={() => {
                if (status === "recording") {
                  stopVisualizer();
                  stopRecording();
                } else {
                  startVisualizer();
                  startRecording();
                }
              }}
            >
              <FaMicrophone
                size={112}
                color={status === "recording" ? "#fff" : "#902EE6"}
              />
            </span>

            <div className={styles.controls}>
              <button
                onClick={() => {
                  startVisualizer();
                  startRecording();
                }}
                disabled={status === "recording"}
              >
                Start
              </button>
              <button
                onClick={() => {
                  stopVisualizer();
                  stopRecording();
                }}
                disabled={status !== "recording"}
              >
                Stop
              </button>
            </div>

            {mediaBlobUrl && (
              <>
                <audio
                  src={mediaBlobUrl}
                  controls
                  className={styles.audioPlayer}
                />
                <button onClick={() => downloadAudio(mediaBlobUrl)}>
                  Save
                </button>
                <button onClick={() => clearBlobUrl()}>Delete</button>
              </>
            )}
          </div>
        )}
      />
    </div>
  );
};

export default MediaRecorder;
