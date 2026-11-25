"""Generate authoritative Solarman V5 byte fixtures using pysolarmanv5.

Run with the old deye-dashboard venv:
  ../deye-dashboard/venv/bin/python backend/test/fixtures/generate_fixtures.py

The TypeScript port is asserted byte-for-byte against these frames.
"""
import json
import os
import struct

from pysolarmanv5.pysolarmanv5 import PySolarmanV5
from umodbus.client.serial import rtu
from umodbus.client.serial.redundancy_check import get_crc


def make_instance(serial: int, seq: int) -> PySolarmanV5:
    obj = PySolarmanV5.__new__(PySolarmanV5)  # skip __init__ (it opens a socket)
    obj.serial = serial
    obj.mb_slave_id = 1
    obj.v5_start = bytes.fromhex("A5")
    obj.v5_length = bytes.fromhex("0000")
    obj.v5_controlcode = struct.pack("<H", 0x4510)
    obj.v5_serial = bytes.fromhex("0000")
    obj.v5_loggerserial = struct.pack("<I", serial)
    obj.v5_frametype = bytes.fromhex("02")
    obj.v5_sensortype = bytes.fromhex("0000")
    obj.v5_deliverytime = bytes.fromhex("00000000")
    obj.v5_powerontime = bytes.fromhex("00000000")
    obj.v5_offsettime = bytes.fromhex("00000000")
    obj.v5_checksum = bytes.fromhex("00")
    obj.v5_end = bytes.fromhex("15")
    obj.sequence_number = seq - 1  # encoder increments before use
    return obj


def make_response(obj: PySolarmanV5, registers: list[int]) -> bytes:
    """Craft a logger response frame the way the device would."""
    data = b"".join(struct.pack(">H", v) for v in registers)
    mb = bytes([obj.mb_slave_id, 0x03, len(data)]) + data
    mb += get_crc(mb)
    payload = bytes.fromhex("02") + bytes(13) + mb  # frametype + 13 filler bytes
    header = (
        bytes.fromhex("A5")
        + struct.pack("<H", len(payload))
        + struct.pack("<H", 0x1510)
        + struct.pack("<H", obj.sequence_number)
        + struct.pack("<I", obj.serial)
    )
    frame = bytearray(header + payload + bytes([0x00, 0x15]))
    checksum = 0
    for i in range(1, len(frame) - 2):
        checksum += frame[i] & 0xFF
    frame[-2] = checksum & 0xFF
    # Sanity: the real pysolarmanv5 decoder must accept it.
    decoded = obj._v5_frame_decoder(bytes(frame))
    assert decoded == mb, "crafted response failed pysolarmanv5 round-trip"
    return bytes(frame)


cases = []
for serial, seq, addr, qty, registers in [
    (2712345678, 42, 183, 9, [5306, 23, 0, 820, 0, 314, 0, 0, 64145]),
    (1234567890, 1, 150, 1, [2346]),
    (987654321, 255, 514, 2, [1500, 230]),
    (2999999999, 7, 598, 12, [2301, 0, 0, 0, 0, 0, 0, 0, 0, 65517, 0, 5001]),
]:
    obj = make_instance(serial, seq)
    mb_request = rtu.read_holding_registers(obj.mb_slave_id, addr, qty)
    v5_request = obj._v5_frame_encoder(mb_request)
    response = make_response(obj, registers)
    cases.append(
        {
            "serial": serial,
            "sequence": seq,
            "slaveId": 1,
            "startAddr": addr,
            "quantity": qty,
            "modbusRequestHex": mb_request.hex(),
            "v5RequestHex": bytes(v5_request).hex(),
            "v5ResponseHex": response.hex(),
            "registers": registers,
        }
    )

out = os.path.join(os.path.dirname(__file__), "v5_frames.json")
with open(out, "w") as f:
    json.dump(cases, f, indent=2)
print(f"Wrote {len(cases)} fixtures to {out}")
