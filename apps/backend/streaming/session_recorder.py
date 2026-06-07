"""
Session Recorder - Record and replay streaming sessions.

Allows recording of streaming sessions for later replay, perfect for learning,
debugging, and sharing development sessions.
"""

import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .streaming_manager import EventType, StreamingEvent


@dataclass
class SessionRecording:
    """A recorded streaming session."""

    session_id: str
    start_time: float
    end_time: float | None
    metadata: dict[str, Any]
    events: list[StreamingEvent]

    def duration(self) -> float:
        """Get session duration in seconds."""
        if self.end_time:
            return self.end_time - self.start_time
        return time.time() - self.start_time

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "metadata": self.metadata,
            "duration": self.duration(),
            "event_count": len(self.events),
            "events": [event.to_dict() for event in self.events],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionRecording":
        """Create from dictionary."""
        events = [
            StreamingEvent(
                event_type=EventType(event["event_type"]),
                timestamp=event["timestamp"],
                data=event["data"],
                session_id=event["session_id"],
            )
            for event in data["events"]
        ]

        return cls(
            session_id=data["session_id"],
            start_time=data["start_time"],
            end_time=data.get("end_time"),
            metadata=data["metadata"],
            events=events,
        )


class SessionRecorder:
    """
    Records streaming sessions for replay.

    Features:
    - Automatic recording of all streaming events
    - Save/load recordings to disk
    - Replay sessions at different speeds
    - Export to video format (future enhancement)
    """

    def __init__(self, recordings_dir: Path | None = None):
        self._recordings_dir = (
            recordings_dir or Path.home() / ".workpilot" / "recordings"
        )
        self._recordings_dir.mkdir(parents=True, exist_ok=True)

        self._active_recordings: dict[str, SessionRecording] = {}

    def start_recording(self, session_id: str, metadata: dict[str, Any]) -> None:
        """Start recording a session."""
        recording = SessionRecording(
            session_id=session_id,
            start_time=time.time(),
            end_time=None,
            metadata=metadata,
            events=[],
        )
        self._active_recordings[session_id] = recording

    def record_event(self, event: StreamingEvent) -> None:
        """Record an event to the active session."""
        session_id = event.session_id
        if session_id in self._active_recordings:
            self._active_recordings[session_id].events.append(event)

    def stop_recording(self, session_id: str) -> SessionRecording | None:
        """Stop recording a session and return the recording."""
        if session_id not in self._active_recordings:
            return None

        recording = self._active_recordings[session_id]
        recording.end_time = time.time()

        # Save to disk
        self.save_recording(recording)

        # Remove from active recordings
        del self._active_recordings[session_id]

        return recording

    def save_recording(self, recording: SessionRecording) -> Path:
        """Save a recording to disk atomically.

        Writes via tempfile + os.replace so a crash mid-write doesn't leave
        a half-written JSON that breaks `list_recordings`. Without this, a
        Ctrl+C during save corrupted the file and silently broke the
        listing UI for every recording in the directory.
        """
        import os
        import tempfile

        timestamp = datetime.fromtimestamp(recording.start_time).strftime(
            "%Y%m%d_%H%M%S"
        )
        filename = f"{timestamp}_{recording.session_id}.json"
        filepath = self._recordings_dir / filename

        fd, tmp_path = tempfile.mkstemp(
            dir=str(self._recordings_dir),
            prefix=f".{filename}.tmp.",
            suffix="",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(recording.to_dict(), f, indent=2)
            os.replace(tmp_path, filepath)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

        return filepath

    def load_recording(self, filepath: Path) -> SessionRecording:
        """Load a recording from disk."""
        with open(filepath) as f:
            data = json.load(f)

        return SessionRecording.from_dict(data)

    def list_recordings(self) -> list[dict[str, Any]]:
        """List all available recordings."""
        recordings = []

        for filepath in self._recordings_dir.glob("*.json"):
            try:
                with open(filepath) as f:
                    data = json.load(f)

                recordings.append(
                    {
                        "filepath": str(filepath),
                        "session_id": data["session_id"],
                        "start_time": data["start_time"],
                        "duration": data.get("duration", 0),
                        "event_count": data.get("event_count", 0),
                        "metadata": data.get("metadata", {}),
                    }
                )
            except Exception as e:
                print(f"Failed to load recording {filepath}: {e}")

        return sorted(recordings, key=lambda x: x["start_time"], reverse=True)

    def delete_recording(self, filepath: Path) -> bool:
        """Delete a recording."""
        try:
            filepath.unlink()
            return True
        except Exception as e:
            print(f"Failed to delete recording {filepath}: {e}")
            return False

    async def replay_session(
        self,
        recording: SessionRecording,
        speed: float = 1.0,
        callback: Any | None = None,
    ) -> None:
        """
        Replay a recorded session.

        Args:
            recording: The recording to replay
            speed: Playback speed (1.0 = real-time, 2.0 = 2x speed, etc.)
            callback: Optional callback function to call for each event
        """
        import asyncio

        if not recording.events:
            return

        start_time = recording.events[0].timestamp

        for event in recording.events:
            # Calculate delay to maintain timing
            relative_time = event.timestamp - start_time
            await asyncio.sleep(relative_time / speed)

            if callback:
                await callback(event)

    def get_session_stats(self, recording: SessionRecording) -> dict[str, Any]:
        """Get statistics about a recorded session."""
        event_types = {}
        file_changes = 0
        commands_run = 0

        for event in recording.events:
            event_types[event.event_type.value] = (
                event_types.get(event.event_type.value, 0) + 1
            )

            if event.event_type in [
                EventType.FILE_CREATE,
                EventType.FILE_UPDATE,
                EventType.FILE_DELETE,
            ]:
                file_changes += 1
            elif event.event_type == EventType.COMMAND_RUN:
                commands_run += 1

        return {
            "duration": recording.duration(),
            "event_count": len(recording.events),
            "event_types": event_types,
            "file_changes": file_changes,
            "commands_run": commands_run,
        }


# Global instance
_session_recorder: SessionRecorder | None = None


def get_session_recorder() -> SessionRecorder:
    """Get or create the global session recorder instance."""
    global _session_recorder
    if _session_recorder is None:
        _session_recorder = SessionRecorder()
    return _session_recorder
