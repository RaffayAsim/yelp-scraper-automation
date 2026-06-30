function normalizeProfileId(b){return b.trim().toLowerCase()}

document.getElementById("addprofilebtn").addEventListener("click",function(){
	const b=document.getElementById("country").value;
	window.open("https://"+b+"/search")
});

document.getElementById("demo_link").addEventListener("click",function(){
	chrome.tabs.create({url:"demo.html"})
});

document.getElementById("demo_video").addEventListener("click",function(){
	chrome.tabs.create({url:"https://www.youtube.com/watch?v=SRQ_OBkix0g"})
});

$(document).ready(function(){
	document.getElementById("managesubscription").style.display="none";
	document.getElementById("loginbtn").innerHTML="Ready";
	document.getElementById("accountinfo").innerHTML="No login required";
});
