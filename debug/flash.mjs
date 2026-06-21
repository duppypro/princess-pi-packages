import fs from "fs";

let text = fs.readFileSync("docs/EXT_WTFT.html", "utf8");

// Apply caps
text = text.replace(/<span style="color: #87af87;">█<\/span> Spec  <span style="color: #87af87; background: #d7875f;">▒<\/span> Mixed  <span style="color: #d7875f;">█<\/span> Code  <span style="color: #ffafaf;">█<\/span> Tests  <span style="color: #af5fd7;">█<\/span> Research  <span style="color: #5fafaf;">█<\/span> Git  <span style="color: #5f87af;">█<\/span> Grep  <span style="color: #d75f87;">░<\/span> Prompt  <span style="color: #444444;">░<\/span> Other/g, 
    '<span style="color: #87af87;">█</span> SPEC  <span style="color: #87af87; background: #d7875f;">▒</span> MIXED  <span style="color: #d7875f;">█</span> CODE  <span style="color: #ffafaf;">█</span> TESTS  <span style="color: #af5fd7;">█</span> RESEARCH  <span style="color: #5fafaf;">█</span> GIT  <span style="color: #5f87af;">█</span> GREP  <span style="color: #d75f87;">░</span> PROMPT  <span style="color: #444444;">░</span> OTHER');

fs.writeFileSync("docs/EXT_WTFT.html", text);

console.log("Flashed to caps! Waiting 8 seconds...");

setTimeout(() => {
    // Revert
    let revertText = fs.readFileSync("docs/EXT_WTFT.html", "utf8");
    revertText = revertText.replace(/<span style="color: #87af87;">█<\/span> SPEC  <span style="color: #87af87; background: #d7875f;">▒<\/span> MIXED  <span style="color: #d7875f;">█<\/span> CODE  <span style="color: #ffafaf;">█<\/span> TESTS  <span style="color: #af5fd7;">█<\/span> RESEARCH  <span style="color: #5fafaf;">█<\/span> GIT  <span style="color: #5f87af;">█<\/span> GREP  <span style="color: #d75f87;">░<\/span> PROMPT  <span style="color: #444444;">░<\/span> OTHER/g, 
    '<span style="color: #87af87;">█</span> Spec  <span style="color: #87af87; background: #d7875f;">▒</span> Mixed  <span style="color: #d7875f;">█</span> Code  <span style="color: #ffafaf;">█</span> Tests  <span style="color: #af5fd7;">█</span> Research  <span style="color: #5fafaf;">█</span> Git  <span style="color: #5f87af;">█</span> Grep  <span style="color: #d75f87;">░</span> Prompt  <span style="color: #444444;">░</span> Other');
    
    fs.writeFileSync("docs/EXT_WTFT.html", revertText);
    console.log("Reverted back to normal!");
}, 8000);
