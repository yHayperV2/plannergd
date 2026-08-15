$all = [System.IO.File]::ReadAllLines("app.js")
Write-Host "Total lines before: $($all.Length)"

# Keep lines 0..2954 (indices, = lines 1..2955) and 3150..end (= lines 3151..end)
$part1 = $all[0..2954]
$part2 = $all[3150..($all.Length - 1)]
$merged = $part1 + $part2

[System.IO.File]::WriteAllLines("app.js", $merged, [System.Text.Encoding]::UTF8)
Write-Host "Done. Total lines after: $($merged.Length)"
