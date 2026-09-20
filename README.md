ssh -i ~/.ssh/wsr_oci ubuntu@<VM_PUBLIC_IP>

tmux new -As wsr

ssh -i ~/.ssh/wsr_oci -t ubuntu@<VM_PUBLIC_IP> tmux new -As wsr

Detach with 

Ctrl-b d