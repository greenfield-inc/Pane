//! Reads the server name from a TLS ClientHello without terminating TLS.

pub enum Hello {
    /// More bytes are needed.
    Incomplete,
    /// Not a TLS ClientHello.
    Invalid,
    /// A complete ClientHello and its server name, if any.
    Complete(Option<String>),
}

pub fn parse_client_hello(buf: &[u8]) -> Hello {
    // A ClientHello may span several handshake records; join their payloads.
    let mut handshake = Vec::new();
    let mut pos = 0;
    loop {
        let Some(header) = buf.get(pos..pos + 5) else {
            return Hello::Incomplete;
        };
        if header[0] != 0x16 {
            return Hello::Invalid;
        }
        let len = u16::from_be_bytes([header[3], header[4]]) as usize;
        let Some(fragment) = buf.get(pos + 5..pos + 5 + len) else {
            return Hello::Incomplete;
        };
        handshake.extend_from_slice(fragment);
        pos += 5 + len;
        if handshake.len() >= 4 {
            if handshake[0] != 1 {
                return Hello::Invalid;
            }
            let body_len =
                u32::from_be_bytes([0, handshake[1], handshake[2], handshake[3]]) as usize;
            if let Some(body) = handshake.get(4..4 + body_len) {
                return match server_name(body) {
                    Some(name) => Hello::Complete(name),
                    None => Hello::Invalid,
                };
            }
        }
    }
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(head)
    }
    fn u8(&mut self) -> Option<usize> {
        self.take(1).map(|b| b[0] as usize)
    }
    fn u16(&mut self) -> Option<usize> {
        self.take(2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]) as usize)
    }
}

/// `Some(None)` when the hello is well formed but carries no server name.
fn server_name(body: &[u8]) -> Option<Option<String>> {
    let mut r = Reader(body);
    r.take(2 + 32)?; // version, random
    let n = r.u8()?;
    r.take(n)?; // session id
    let n = r.u16()?;
    r.take(n)?; // cipher suites
    let n = r.u8()?;
    r.take(n)?; // compression methods
    if r.0.is_empty() {
        return Some(None);
    }
    let n = r.u16()?;
    let mut exts = Reader(r.take(n)?);
    while !exts.0.is_empty() {
        let kind = exts.u16()?;
        let n = exts.u16()?;
        let data = exts.take(n)?;
        if kind != 0 {
            continue;
        }
        let mut list = Reader(data);
        let n = list.u16()?;
        let mut names = Reader(list.take(n)?);
        while !names.0.is_empty() {
            let name_type = names.u8()?;
            let n = names.u16()?;
            let name = names.take(n)?;
            if name_type == 0 {
                let name = std::str::from_utf8(name).ok()?;
                return Some(Some(name.trim_end_matches('.').to_ascii_lowercase()));
            }
        }
    }
    Some(None)
}
