"""Strict tool objects with a narrowly bounded redundant-delimiter repair."""
import json


def reject_constant(value):raise ValueError('Tool JSON contains a non-finite number.')


def parse_tool_object(text):
    if not isinstance(text,str):raise ValueError('Tool arguments must be JSON text.')
    decoder=json.JSONDecoder(parse_constant=reject_constant)
    value,end=decoder.raw_decode(text.lstrip())
    trailing=text.lstrip()[end:].strip()
    if not isinstance(value,dict):raise ValueError('Tool arguments must be one JSON object.')
    # Do not repair strings, values, missing delimiters or multiple objects.
    # A single extra closing brace cannot change an already complete object.
    if trailing not in ('','}'):raise ValueError('Tool arguments contain trailing data.')
    return value,trailing=='}'


def loads_tool_object(text):return parse_tool_object(text)[0]
