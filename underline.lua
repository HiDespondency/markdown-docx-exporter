function Inlines(inlines)
  local result = {}
  local underline_buffer = nil

  for _, inline in ipairs(inlines) do
    if inline.t == "RawInline" and inline.format == "html" then
      local text = inline.text:lower()
      if text == "<u>" then
        underline_buffer = {}
      elseif text == "</u>" and underline_buffer ~= nil then
        table.insert(result, pandoc.Underline(underline_buffer))
        underline_buffer = nil
      elseif underline_buffer ~= nil then
        table.insert(underline_buffer, inline)
      else
        table.insert(result, inline)
      end
    elseif underline_buffer ~= nil then
      table.insert(underline_buffer, inline)
    else
      table.insert(result, inline)
    end
  end

  if underline_buffer ~= nil then
    for _, inline in ipairs(underline_buffer) do
      table.insert(result, inline)
    end
  end

  return result
end
