#!/usr/bin/env python3
"""
WebSocket Server Standalone
==========================

Runs the WebSocket server in a separate process to avoid conflicts with FastAPI.
"""

import asyncio
import logging
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("websocket_server.log"),
    ],
)

logger = logging.getLogger(__name__)


async def main():
    """Main entry point for standalone WebSocket server."""
    try:
        logger.info("Starting standalone WebSocket server...")

        from streaming.session_recorder import SessionRecorder
        from streaming.streaming_manager import get_streaming_manager
        from streaming.websocket_server import get_websocket_server

        # Initialize components — instantiate for side effects (singleton init,
        # registration). Return values are intentionally discarded.
        server = get_websocket_server()
        SessionRecorder()
        get_streaming_manager()

        logger.info("WebSocket server components initialized")

        # Start the server
        await server.start()

        logger.info("WebSocket server started successfully")

        # Keep the server running
        try:
            while True:
                await asyncio.sleep(1)
        except (KeyboardInterrupt, asyncio.CancelledError):
            logger.info("Shutdown signal received")

    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("WebSocket server shutdown requested")
        # Don't re-raise these exceptions for clean shutdown
    except Exception as e:
        logger.error(f"WebSocket server error: {e}")
        raise
    finally:
        # Cleanup
        try:
            from streaming.websocket_server import get_websocket_server

            server = get_websocket_server()
            await server.stop()
            logger.info("WebSocket server stopped")
        except Exception as e:
            logger.error(f"Error stopping WebSocket server: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("WebSocket server stopped by user")
    except asyncio.CancelledError:
        logger.info("WebSocket server cancelled")
