use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::models::WsMessage;

const TR_WS_URL: &str = "wss://api.traderepublic.com";
const CONNECT_VERSION: u32 = 31;
const ECHO_INTERVAL: Duration = Duration::from_secs(30);

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

#[derive(thiserror::Error, Debug)]
pub enum WsError {
    #[error("WebSocket error: {0}")]
    Tungstenite(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Not connected")]
    NotConnected,
    #[error("Unexpected response: {0}")]
    UnexpectedResponse(String),
}

pub struct TradeRepublicClient {
    sink: Arc<Mutex<Option<WsSink>>>,
    stream: Arc<Mutex<Option<WsStream>>>,
    next_id: AtomicU32,
}

impl TradeRepublicClient {
    pub fn new() -> Self {
        Self {
            sink: Arc::new(Mutex::new(None)),
            stream: Arc::new(Mutex::new(None)),
            next_id: AtomicU32::new(1),
        }
    }

    /// Connect to TR WebSocket and send the handshake.
    pub async fn connect(&self, session_cookie: Option<&str>) -> Result<(), WsError> {
        let mut req = Request::builder()
            .uri(TR_WS_URL)
            .header("Origin", "https://app.traderepublic.com");

        if let Some(cookie) = session_cookie {
            req = req.header("Cookie", cookie);
        }

        let req = req
            .body(())
            .map_err(|e| WsError::ConnectionFailed(e.to_string()))?;

        let (ws, _resp) = connect_async(req).await?;
        let (sink, stream) = ws.split();

        *self.sink.lock().await = Some(sink);
        *self.stream.lock().await = Some(stream);

        // Send connect handshake
        let connect_payload = serde_json::json!({
            "locale": "en",
            "platformId": "webtrading",
            "clientId": "app.traderepublic.com",
            "clientVersion": "5582"
        });
        let connect_msg = format!("connect {CONNECT_VERSION} {connect_payload}");
        self.send_raw(&connect_msg).await?;

        // Wait for "connected" response
        let msg = self.recv().await?;
        match msg {
            WsMessage::Connected => Ok(()),
            other => Err(WsError::UnexpectedResponse(format!("{other:?}"))),
        }
    }

    /// Subscribe to a TR data stream. Returns the subscription ID.
    pub async fn subscribe(&self, payload: Value) -> Result<u32, WsError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = format!("sub {id} {payload}");
        self.send_raw(&msg).await?;
        Ok(id)
    }

    /// Unsubscribe from a stream.
    pub async fn unsubscribe(&self, id: u32) -> Result<(), WsError> {
        let msg = format!("unsub {id}");
        self.send_raw(&msg).await
    }

    /// Subscribe and wait for the first full answer (type A).
    pub async fn subscribe_and_wait(&self, payload: Value) -> Result<Value, WsError> {
        let sub_id = self.subscribe(payload).await?;

        loop {
            let msg = self.recv().await?;
            match msg {
                WsMessage::Answer { id, payload } if id == sub_id => {
                    self.unsubscribe(sub_id).await?;
                    return Ok(payload);
                }
                WsMessage::Error { id, payload } if id == sub_id => {
                    return Err(WsError::UnexpectedResponse(format!(
                        "subscription {id} error: {payload}"
                    )));
                }
                WsMessage::Complete { id } if id == sub_id => {
                    return Err(WsError::UnexpectedResponse(format!(
                        "subscription {id} completed without data"
                    )));
                }
                _ => continue, // ignore messages for other subscriptions
            }
        }
    }

    /// Read the next message from the WebSocket.
    pub async fn recv(&self) -> Result<WsMessage, WsError> {
        loop {
            let frame = {
                let mut guard = self.stream.lock().await;
                let stream = guard.as_mut().ok_or(WsError::NotConnected)?;
                stream
                    .next()
                    .await
                    .ok_or(WsError::NotConnected)?
                    .map_err(WsError::Tungstenite)?
            }; // guard dropped here

            match frame {
                Message::Text(text) => return Ok(parse_message(&text)),
                Message::Ping(data) => {
                    self.send_pong(data).await?;
                }
                Message::Close(_) => return Err(WsError::NotConnected),
                _ => continue,
            }
        }
    }

    /// Send echo keepalive. Call this periodically.
    pub async fn send_echo(&self) -> Result<(), WsError> {
        self.send_raw("echo").await
    }

    /// Spawn a background task that sends echo every 30s.
    pub fn spawn_keepalive(&self) -> tokio::task::JoinHandle<()> {
        let sink = Arc::clone(&self.sink);
        tokio::spawn(async move {
            let mut interval = time::interval(ECHO_INTERVAL);
            loop {
                interval.tick().await;
                let mut guard = sink.lock().await;
                if let Some(ref mut s) = *guard {
                    if s.send(Message::Text("echo".into())).await.is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        })
    }

    /// Close the WebSocket connection.
    pub async fn disconnect(&self) {
        if let Some(mut sink) = self.sink.lock().await.take() {
            let _ = sink.close().await;
        }
        self.stream.lock().await.take();
    }

    async fn send_raw(&self, msg: &str) -> Result<(), WsError> {
        let mut guard = self.sink.lock().await;
        let sink = guard.as_mut().ok_or(WsError::NotConnected)?;
        sink.send(Message::Text(msg.into()))
            .await
            .map_err(WsError::Tungstenite)
    }

    async fn send_pong(&self, data: Vec<u8>) -> Result<(), WsError> {
        let mut guard = self.sink.lock().await;
        let sink = guard.as_mut().ok_or(WsError::NotConnected)?;
        sink.send(Message::Pong(data))
            .await
            .map_err(WsError::Tungstenite)
    }
}

/// Parse a raw TR WebSocket text message.
fn parse_message(raw: &str) -> WsMessage {
    let trimmed = raw.trim();

    if trimmed == "connected" {
        return WsMessage::Connected;
    }
    if trimmed == "echo" {
        return WsMessage::Echo;
    }

    // Format: "{id} {type} {optional_payload}"
    let Some((id_str, rest)) = trimmed.split_once(' ') else {
        return WsMessage::Unknown(raw.to_string());
    };
    let Ok(id) = id_str.parse::<u32>() else {
        return WsMessage::Unknown(raw.to_string());
    };

    let (msg_type, payload_str) = rest
        .split_once(' ')
        .map(|(t, p)| (t, Some(p)))
        .unwrap_or((rest, None));

    match msg_type {
        "A" => {
            let payload = payload_str
                .and_then(|p| serde_json::from_str(p).ok())
                .unwrap_or(Value::Null);
            WsMessage::Answer { id, payload }
        }
        "D" => WsMessage::Delta {
            id,
            raw: payload_str.unwrap_or("").to_string(),
        },
        "C" => WsMessage::Complete { id },
        "E" => {
            let payload = payload_str
                .and_then(|p| serde_json::from_str(p).ok())
                .unwrap_or(Value::Null);
            WsMessage::Error { id, payload }
        }
        _ => WsMessage::Unknown(raw.to_string()),
    }
}
