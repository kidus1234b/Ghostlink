#!/bin/bash
python3 -c "
import ssl, http.server
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('cert.pem', 'key.pem')
httpd = http.server.HTTPServer(('0.0.0.0', 8443), http.server.SimpleHTTPRequestHandler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print('Serving HTTPS on https://0.0.0.0:8443')
httpd.serve_forever()
"
