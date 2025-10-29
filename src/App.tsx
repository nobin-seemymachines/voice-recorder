import AudioRecorder from "./components/AudioRecorder";
import type { AudioRecorderHandle } from "./components/AudioRecorder";
import "./App.css";
import { useEffect, useRef, useState } from "react";

const App = () => {
  const recorderRef = useRef<AudioRecorderHandle | null>(null);
  const [savedFile, setSavedFile] = useState<File | null>(null);

  useEffect(() => {
    console.log(savedFile);
  }, [savedFile]);

  return (
    <div
      className="App"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <AudioRecorder
        ref={recorderRef}
        maxDurationSeconds={50}
        onSave={(file) => setSavedFile(file)}
      />
      {savedFile && (
        <div style={{ marginTop: 8 }}>
          <div>Saved: {savedFile.name}</div>
          <div>Size: {(savedFile.size / 1024).toFixed(1)} KB</div>
        </div>
      )}
    </div>
  );
};

export default App;
