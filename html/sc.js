const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIzZGIyNTA5My0yNzYwLTQ4NmYtYWRjYS05ZWE0OWMwZDVlOTMiLCJlbWFpbCI6ImRldjJAaG1haWwuY29tIiwiaWF0IjoxNzg5NjQ5OTgzLCJleHAiOjE3ODk3MzYzODN9.xaI21g9dix8jXATkPZ0OPJE_lAuyASTBdfN3pHPom7Q";
const ws = new WebSocket(`ws://localhost:3000/api/v1/ws?token=${token}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Real-time file update received:", data);
  
  // Example UI update
  if (data.status === "COMPLETED") {
    // Fetch presigned GET URL for data.fileId and display thumbnail
    print("completed")
  } else if (data.status === "FAILED") {
    showErrorNotification(`Processing failed: ${data.error}`);
  }
};